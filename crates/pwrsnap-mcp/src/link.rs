//! Transport only. Identity checks exclude other accounts; desktop consent
//! still authorizes every MCP session. No socket name grants tool access.
use std::{
    io,
    path::{Path, PathBuf},
};
use tokio::io::{AsyncRead, AsyncWrite};
pub trait StreamIo: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> StreamIo for T {}
pub type Stream = Box<dyn StreamIo>;

pub fn endpoint() -> io::Result<PathBuf> {
    #[cfg(unix)]
    {
        Ok(PathBuf::from(format!(
            "/tmp/pwrsnap-mcp-{}/mcp.sock",
            rustix::process::geteuid().as_raw()
        )))
    }
    #[cfg(windows)]
    {
        crate::windows::default_path()
    }
}
#[cfg(windows)]
pub use crate::windows::McpListener as Listener;
#[cfg(windows)]
pub async fn connect(path: &Path) -> io::Result<Stream> {
    crate::windows::mcp_connect(path).await
}

#[cfg(unix)]
mod unix {
    use super::*;
    use std::{
        fs::{self, File, OpenOptions},
        os::unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    };
    use tokio::net::{UnixListener, UnixStream};
    fn uid() -> u32 {
        rustix::process::geteuid().as_raw()
    }
    fn denied() -> io::Error {
        io::Error::new(
            io::ErrorKind::PermissionDenied,
            "MCP endpoint must be in a private directory owned by this account",
        )
    }
    fn directory(path: &Path, create: bool) -> io::Result<()> {
        let parent = path.parent().ok_or_else(denied)?;
        if create {
            use std::os::unix::fs::DirBuilderExt;
            match fs::DirBuilder::new().mode(0o700).create(parent) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(e),
            }
        }
        let m = fs::symlink_metadata(parent)?;
        if !m.is_dir() || m.uid() != uid() || m.mode() & 0o077 != 0 {
            return Err(denied());
        }
        Ok(())
    }
    fn check_peer(stream: &UnixStream) -> io::Result<()> {
        if stream.peer_cred()?.uid() != uid() {
            return Err(denied());
        }
        Ok(())
    }
    pub struct Listener {
        inner: UnixListener,
        path: PathBuf,
        identity: (u64, u64),
        _lock: File,
    }
    impl Listener {
        pub fn bind(path: &Path) -> io::Result<Self> {
            directory(path, true)?;
            // Cooperating desktops serialize stale cleanup and binding. Never
            // unlink the lock: doing so would permit two distinct locked inodes.
            let lock = OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .mode(0o600)
                .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32)
                .open(path.with_extension("lock"))?;
            let m = lock.metadata()?;
            if !m.is_file() || m.uid() != uid() || m.mode() & 0o077 != 0 {
                return Err(denied());
            }
            rustix::fs::flock(&lock, rustix::fs::FlockOperation::NonBlockingLockExclusive)?;
            if let Ok(m) = fs::symlink_metadata(path) {
                if !m.file_type().is_socket() || m.uid() != uid() {
                    return Err(denied());
                }
                match std::os::unix::net::UnixStream::connect(path) {
                    Err(e) if e.kind() == io::ErrorKind::ConnectionRefused => {}
                    _ => {
                        return Err(io::Error::new(
                            io::ErrorKind::AddrInUse,
                            "another desktop owns the endpoint",
                        ));
                    }
                }
                let current = fs::symlink_metadata(path)?;
                if (m.dev(), m.ino()) != (current.dev(), current.ino()) {
                    return Err(denied());
                }
                fs::remove_file(path)?;
            }
            let inner = UnixListener::bind(path)?;
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
            let m = fs::symlink_metadata(path)?;
            Ok(Self {
                inner,
                path: path.into(),
                identity: (m.dev(), m.ino()),
                _lock: lock,
            })
        }
        pub async fn accept(&mut self) -> io::Result<Stream> {
            let (stream, _) = self.inner.accept().await?;
            check_peer(&stream)?;
            Ok(Box::new(stream))
        }
    }
    impl Drop for Listener {
        fn drop(&mut self) {
            if let Ok(m) = fs::symlink_metadata(&self.path)
                && m.file_type().is_socket()
                && m.uid() == uid()
                && (m.dev(), m.ino()) == self.identity
            {
                let _ = fs::remove_file(&self.path);
            }
        }
    }
    pub async fn connect(path: &Path) -> io::Result<Stream> {
        directory(path, false)?;
        let m = fs::symlink_metadata(path)?;
        if !m.file_type().is_socket() || m.uid() != uid() || m.mode() & 0o077 != 0 {
            return Err(denied());
        }
        let stream = UnixStream::connect(path).await?;
        check_peer(&stream)?;
        Ok(Box::new(stream))
    }
}
#[cfg(unix)]
pub use unix::{Listener, connect};

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{
        fs,
        os::unix::fs::{PermissionsExt, symlink},
    };
    fn private_dir() -> tempfile::TempDir {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        dir
    }
    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }
    #[test]
    fn private_socket_is_duplex_and_live_ownership_cannot_be_stolen() {
        runtime().block_on(async {
            let dir = private_dir();
            let path = dir.path().join("mcp.sock");
            let mut listener = Listener::bind(&path).unwrap();
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert!(Listener::bind(&path).is_err());
            let client = connect(&path).await.unwrap();
            let server = listener.accept().await.unwrap();
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let (mut client, mut server) = (client, server);
            client.write_all(b"request\n").await.unwrap();
            let mut bytes = [0; 8];
            server.read_exact(&mut bytes).await.unwrap();
            assert_eq!(&bytes, b"request\n");
            server.write_all(b"notice\n").await.unwrap();
            let mut bytes = [0; 7];
            client.read_exact(&mut bytes).await.unwrap();
            assert_eq!(&bytes, b"notice\n");
            drop(client);
            drop(server);
            drop(listener);
            assert!(!path.exists());
        });
    }
    #[test]
    fn no_regular_file_or_symlink_is_removed_as_a_stale_socket() {
        runtime().block_on(async {
            let dir = private_dir();
            let path = dir.path().join("mcp.sock");
            fs::write(&path, "valuable").unwrap();
            assert!(Listener::bind(&path).is_err());
            assert_eq!(fs::read_to_string(&path).unwrap(), "valuable");
            fs::remove_file(&path).unwrap();
            let target = dir.path().join("target");
            fs::write(&target, "valuable").unwrap();
            symlink(&target, &path).unwrap();
            assert!(Listener::bind(&path).is_err());
            assert!(
                fs::symlink_metadata(&path)
                    .unwrap()
                    .file_type()
                    .is_symlink()
            );
        });
    }
    #[test]
    fn a_stale_owned_socket_is_recovered_under_the_ownership_lock() {
        runtime().block_on(async {
            let dir = private_dir();
            let path = dir.path().join("mcp.sock");
            drop(std::os::unix::net::UnixListener::bind(&path).unwrap());
            let listener = Listener::bind(&path).unwrap();
            drop(listener);
            assert!(!path.exists());
        });
    }
    #[test]
    fn cleanup_never_unlinks_a_replacement_inode() {
        runtime().block_on(async {
            let dir = private_dir();
            let path = dir.path().join("mcp.sock");
            let listener = Listener::bind(&path).unwrap();
            fs::remove_file(&path).unwrap();
            fs::write(&path, "replacement").unwrap();
            drop(listener);
            assert_eq!(fs::read_to_string(path).unwrap(), "replacement");
        });
    }
    #[test]
    fn public_or_symlinked_directories_fail_closed_without_chmodding_them() {
        runtime().block_on(async {
            let dir = private_dir();
            fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o755)).unwrap();
            assert!(Listener::bind(&dir.path().join("mcp.sock")).is_err());
            assert_eq!(
                fs::metadata(dir.path()).unwrap().permissions().mode() & 0o777,
                0o755
            );
            let parent = private_dir();
            symlink(dir.path(), parent.path().join("alias")).unwrap();
            assert!(Listener::bind(&parent.path().join("alias/mcp.sock")).is_err());
        });
    }
}
