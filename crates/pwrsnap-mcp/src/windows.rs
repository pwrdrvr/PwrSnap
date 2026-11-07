//! Adapted from PwrDisk's MIT-licensed disktree-link Windows transport.
//! Copyright (c) 2026 Tobi Lütke and PwrDisk contributors.
//! Protected SID-only DACL, local clients, owner verification and cancellation.
use std::os::windows::{
    ffi::OsStrExt as _,
    io::{AsRawHandle, FromRawHandle as _, OwnedHandle},
};
use std::{
    ffi::c_void,
    io,
    path::{Path, PathBuf},
    ptr,
    time::Duration,
};
use tokio::{
    io::AsyncRead,
    net::windows::named_pipe::{ClientOptions, NamedPipeClient, NamedPipeServer, ServerOptions},
    time::{sleep, timeout},
};
use windows_sys::Win32::{
    Foundation::{ERROR_ACCESS_DENIED, ERROR_PIPE_BUSY, HANDLE, LocalFree},
    Security::{
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
            GetSecurityInfo, SDDL_REVISION_1, SE_KERNEL_OBJECT,
        },
        GetTokenInformation, OWNER_SECURITY_INFORMATION, SECURITY_ATTRIBUTES, TOKEN_QUERY,
        TOKEN_USER, TokenUser,
    },
    System::{
        IO::CancelIoEx,
        Pipes::DisconnectNamedPipe,
        Threading::{GetCurrentProcess, OpenProcessToken},
    },
};
const WRITE_WAIT: Duration = Duration::from_secs(2);
const CONNECT_TICK: Duration = Duration::from_millis(10);
async fn connect(path: &Path) -> io::Result<NamedPipeClient> {
    connect_for_user(path, &current_sid()?).await
}

async fn connect_for_user(path: &Path, user: &str) -> io::Result<NamedPipeClient> {
    timeout(WRITE_WAIT, async {
        loop {
            // Tokio uses SECURITY_IDENTIFICATION: a pipe server cannot
            // impersonate an elevated agent that connects to its name.
            match ClientOptions::new().open(path) {
                Ok(pipe) => {
                    // The name and a server-supplied DACL prove nothing:
                    // another account could have claimed this name first.
                    // Query this connected handle, never the path, before
                    // sending Hello, marks, or any other protocol data.
                    if pipe_owner(pipe.as_raw_handle())? != user {
                        return Err(io::Error::new(
                            io::ErrorKind::PermissionDenied,
                            "the PwrSnap pipe belongs to another user",
                        ));
                    }
                    return Ok(pipe);
                }
                Err(error) if error.raw_os_error() == Some(ERROR_PIPE_BUSY.cast_signed()) => {
                    sleep(CONNECT_TICK).await;
                }
                Err(error) => return Err(error),
            }
        }
    })
    .await?
}

fn pipe_owner(handle: HANDLE) -> io::Result<String> {
    let mut owner = ptr::null_mut();
    let mut descriptor = ptr::null_mut();
    // SAFETY: Windows validates the handle; both outputs are valid pointers.
    // The client's GENERIC_READ/WRITE rights include READ_CONTROL.
    let status = unsafe {
        GetSecurityInfo(
            handle,
            SE_KERNEL_OBJECT,
            OWNER_SECURITY_INFORMATION,
            &raw mut owner,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            &raw mut descriptor,
        )
    };
    if status != 0 {
        return Err(io::Error::from_raw_os_error(status.cast_signed()));
    }
    let _allocation = LocalAllocation(descriptor);
    if owner.is_null() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "the PwrSnap pipe has no verifiable owner",
        ));
    }
    // SAFETY: owner points into the live security descriptor above.
    unsafe { sid_text(owner) }
}

/// Mio deliberately lets pending writes finish after dropping a pipe.
/// Cancel them explicitly: a peer that never reads must not retain this
/// instance after a timeout or prevent a new window from claiming its name.
#[derive(Debug)]
struct PipeIo<T: AsRawHandle> {
    pipe: T,
    server: bool,
}

impl<T: AsRawHandle + AsyncRead + Unpin> tokio::io::AsyncRead for PipeIo<T> {
    fn poll_read(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<io::Result<()>> {
        std::pin::Pin::new(&mut self.get_mut().pipe).poll_read(cx, buf)
    }
}

impl<T: AsRawHandle + tokio::io::AsyncWrite + Unpin> tokio::io::AsyncWrite for PipeIo<T> {
    fn poll_write(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<io::Result<usize>> {
        std::pin::Pin::new(&mut self.get_mut().pipe).poll_write(cx, buf)
    }

    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<io::Result<()>> {
        std::pin::Pin::new(&mut self.get_mut().pipe).poll_flush(cx)
    }

    fn poll_shutdown(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<io::Result<()>> {
        std::pin::Pin::new(&mut self.get_mut().pipe).poll_shutdown(cx)
    }
}

/// MCP shares the typed link's SID, protected DACL, remote rejection,
/// connected-owner verification and cancellation on drop.
#[derive(Debug)]
pub struct McpListener {
    path: PathBuf,
    server: NamedPipeServer,
}

impl McpListener {
    pub(crate) fn bind(path: &Path) -> io::Result<Self> {
        validate_path(path)?;
        Ok(Self {
            path: path.into(),
            server: Security::current_user()?.create(path, true)?,
        })
    }

    pub(crate) async fn accept(&mut self) -> io::Result<crate::link::Stream> {
        if let Err(error) = self.server.connect().await {
            // A client may vanish before ConnectNamedPipe completes. Reclaim
            // this cancelled instance before accepting another local client.
            let _ = self.server.disconnect();
            return Err(error);
        }
        // Keep the existing instance until its successor has claimed the
        // name. A descriptor is allocated only during this synchronous call.
        let next = Security::current_user()?.create(&self.path, false)?;
        let pipe = std::mem::replace(&mut self.server, next);
        Ok(Box::new(PipeIo { pipe, server: true }))
    }
}

pub async fn mcp_connect(path: &Path) -> io::Result<crate::link::Stream> {
    validate_path(path)?;
    Ok(Box::new(PipeIo {
        pipe: connect(path).await?,
        server: false,
    }))
}

impl<T: AsRawHandle> Drop for PipeIo<T> {
    fn drop(&mut self) {
        // SAFETY: pipe owns a live overlapped handle. Null means every I/O
        // operation on it; Mio retains each OVERLAPPED until completion.
        unsafe {
            CancelIoEx(self.pipe.as_raw_handle(), ptr::null());
        }
        if self.server {
            // SAFETY: only a server pipe sets this flag. Disconnect also
            // invalidates idle client handles before the server closes.
            unsafe {
                DisconnectNamedPipe(self.pipe.as_raw_handle());
            }
        }
    }
}

fn validate_path(path: &Path) -> io::Result<()> {
    let name = path.to_string_lossy();
    if name
        .get(..9)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(r"\\.\pipe\"))
        && name.len() > 9
        && !name[9..].contains(['\\', '/'])
        && !name.contains('\0')
    {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "expected a local \\\\.\\pipe\\name",
        ))
    }
}

pub fn default_path() -> io::Result<PathBuf> {
    Ok(PathBuf::from(format!(
        r"\\.\pipe\pwrsnap-mcp-{}",
        current_sid()?
    )))
}

/// Memory Windows allocated with `LocalAlloc`; both SID strings and security
/// descriptors must be released with `LocalFree`, including on error paths.
struct LocalAllocation(*mut c_void);

impl Drop for LocalAllocation {
    fn drop(&mut self) {
        // SAFETY: this pointer came from a successful allocating Win32 API.
        unsafe {
            LocalFree(self.0);
        }
    }
}

fn current_sid() -> io::Result<String> {
    let mut token = ptr::null_mut();
    // SAFETY: the process pseudo-handle is valid; token is an out pointer.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: OpenProcessToken returned a unique owned handle.
    let _token = unsafe { OwnedHandle::from_raw_handle(token) };
    let mut bytes = 0;
    // SAFETY: null buffer and zero size query the required length only.
    unsafe {
        GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &raw mut bytes);
    }
    // TOKEN_USER contains pointers, so allocate aligned storage for it and
    // the SID Windows writes after it, rather than casting a byte buffer.
    let mut buffer = vec![0_usize; (bytes as usize).div_ceil(size_of::<usize>())];
    // SAFETY: buffer has the queried size and TOKEN_USER's pointer alignment.
    if unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            bytes,
            &raw mut bytes,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: a successful TokenUser query filled a TOKEN_USER at this address.
    let user = unsafe { &*buffer.as_ptr().cast::<TOKEN_USER>() };
    // SAFETY: the SID belongs to buffer and remains alive through conversion.
    unsafe { sid_text(user.User.Sid) }
}

/// `sid` must point to a valid SID for the duration of this call.
unsafe fn sid_text(sid: *mut c_void) -> io::Result<String> {
    let mut text = ptr::null_mut();
    // SAFETY: the caller guarantees a valid SID; text is an out pointer.
    if unsafe { ConvertSidToStringSidW(sid, &raw mut text) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let _allocation = LocalAllocation(text.cast());
    let mut len = 0;
    // SAFETY: successful conversion returns a null-terminated UTF-16 string.
    unsafe {
        while *text.add(len) != 0 {
            len += 1;
        }
    }
    // SAFETY: len stops at the terminator inside the allocated SID string.
    Ok(String::from_utf16_lossy(unsafe {
        std::slice::from_raw_parts(text, len)
    }))
}

struct Security(LocalAllocation);

impl Security {
    fn current_user() -> io::Result<Self> {
        // A protected DACL grants only this SID access. No Everyone,
        // authenticated-users or administrators ACE is inherited.
        let sid = current_sid()?;
        // An elevated token's default owner can be Administrators rather
        // than TokenUser. Both sides identify the account by TokenUser.
        Self::from_sddl(&format!("O:{sid}D:P(A;;GA;;;{sid})"))
    }

    fn from_sddl(sddl: &str) -> io::Result<Self> {
        let sddl: Vec<u16> = std::ffi::OsStr::new(sddl)
            .encode_wide()
            .chain(Some(0))
            .collect();
        let mut descriptor = ptr::null_mut();
        // SAFETY: SDDL is terminated and descriptor is an out pointer.
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &raw mut descriptor,
                ptr::null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Self(LocalAllocation(descriptor)))
    }

    fn create(&self, path: &Path, first: bool) -> io::Result<NamedPipeServer> {
        let mut attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.0.0,
            bInheritHandle: 0,
        };
        // SAFETY: the descriptor and attributes live through CreateNamedPipeW,
        // which copies the descriptor; the handle is not inheritable.
        let result = unsafe {
            ServerOptions::new()
                .first_pipe_instance(first)
                .reject_remote_clients(true)
                .create_with_security_attributes_raw(path, (&raw mut attributes).cast())
        };
        match result {
            Err(error)
                if first && error.raw_os_error() == Some(ERROR_ACCESS_DENIED.cast_signed()) =>
            {
                Err(io::Error::new(
                    io::ErrorKind::AddrInUse,
                    "another PwrSnap window owns this pipe, or access was denied",
                ))
            }
            result => result,
        }
    }
}

impl Drop for McpListener {
    fn drop(&mut self) {
        // SAFETY: the listener owns this live overlapped pipe handle.
        unsafe {
            CancelIoEx(self.server.as_raw_handle(), ptr::null());
            DisconnectNamedPipe(self.server.as_raw_handle());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::Security::{
        ACCESS_ALLOWED_ACE, DACL_SECURITY_INFORMATION, GetAce, GetSecurityDescriptorControl,
        SE_DACL_PROTECTED,
    };
    fn endpoint() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = PathBuf::from(format!(
            r"\\.\pipe\pwrsnap-test-{}",
            dir.path().file_name().unwrap().to_string_lossy()
        ));
        (dir, path)
    }
    #[test]
    fn the_kernel_pipe_has_one_protected_allow_ace_for_this_user() {
        let (_dir, path) = endpoint();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let _entered = runtime.enter();
        let pipe = Security::current_user()
            .expect("security")
            .create(&path, true)
            .expect("pipe");
        assert_eq!(
            pipe_owner(pipe.as_raw_handle()).expect("pipe owner"),
            current_sid().expect("user SID")
        );
        let mut descriptor = ptr::null_mut();
        let mut acl = ptr::null_mut();
        // SAFETY: pipe is live, and the requested outputs are valid pointers.
        let status = unsafe {
            GetSecurityInfo(
                pipe.as_raw_handle(),
                SE_KERNEL_OBJECT,
                DACL_SECURITY_INFORMATION,
                ptr::null_mut(),
                ptr::null_mut(),
                &raw mut acl,
                ptr::null_mut(),
                &raw mut descriptor,
            )
        };
        assert_eq!(status, 0, "GetSecurityInfo");
        let _allocation = LocalAllocation(descriptor);
        assert!(!acl.is_null(), "a null DACL allows everyone");
        let mut control = 0;
        let mut revision = 0;
        // SAFETY: descriptor is the live allocation returned above.
        assert_ne!(
            unsafe {
                GetSecurityDescriptorControl(descriptor, &raw mut control, &raw mut revision)
            },
            0
        );
        assert_ne!(control & SE_DACL_PROTECTED, 0, "no inherited grants");
        // SAFETY: acl points inside descriptor and is not null.
        assert_eq!(unsafe { (*acl).AceCount }, 1, "only one identity");
        let mut ace = ptr::null_mut();
        // SAFETY: the queried ACL has one ACE, and ace is an out pointer.
        assert_ne!(unsafe { GetAce(acl, 0, &raw mut ace) }, 0);
        // SAFETY: the descriptor was constructed with one ACCESS_ALLOWED_ACE.
        let ace = unsafe { &*ace.cast::<ACCESS_ALLOWED_ACE>() };
        assert_eq!(ace.Header.AceType, 0, "ACCESS_ALLOWED_ACE_TYPE");
        // SAFETY: SidStart is the start of the variable-length SID in this ACE.
        let sid =
            unsafe { sid_text((&raw const ace.SidStart).cast_mut().cast()) }.expect("ACE SID");
        assert_eq!(sid, current_sid().expect("user SID"));
    }

    #[test]
    fn a_permissive_pipe_owned_by_a_different_sid_is_rejected() {
        let (_dir, path) = endpoint();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let owner = current_sid().expect("server SID");
        // Model the client as a different account without requiring a
        // second Windows login or privileges on the CI runner. This pipe
        // admits everyone, just like a squatter's pipe, but its real owner
        // must still match the client's expected account.
        let client = "S-1-5-21-0-0-0-1234";
        assert_ne!(owner, client);
        let _server = {
            let _entered = runtime.enter();
            Security::from_sddl(&format!("O:{owner}D:P(A;;GA;;;WD)"))
                .expect("permissive security")
                .create(&path, true)
                .expect("squatter's pipe")
        };
        let error = runtime
            .block_on(connect_for_user(&path, client))
            .expect_err("a matching name and permissive ACL are not identity");
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert!(error.to_string().contains("belongs to another user"));
    }

    #[test]
    fn an_unreadable_pipe_owner_is_not_trusted() {
        assert!(pipe_owner(ptr::null_mut()).is_err());
    }
}
