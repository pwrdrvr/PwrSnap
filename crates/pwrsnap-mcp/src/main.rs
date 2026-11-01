//! A byte relay, never an MCP server. The independently launched desktop
//! owns MCP and authorization. No command execution or application launch.
mod link;
#[cfg(windows)]
mod windows;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use std::{collections::HashMap, io, path::Path, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    sync::mpsc,
    task::JoinSet,
};
const WIRE: &str = "PWRSNAP-MCP/1";
const VERSION: &str = env!("CARGO_PKG_VERSION");
const MANUAL: &str = "Open PwrSnap yourself, enable Local agents in Settings, then manually reconnect this MCP server in your host. No requests were replayed.";
const MAX_CONTROL: u64 = 128 * 1024;
const MAX_PEERS: usize = 128;
#[derive(Debug)]
enum Frame {
    Ready,
    Open {
        id: u64,
        relay_version: String,
        identity: Option<String>,
    },
    Data {
        id: u64,
        data: String,
    },
    Close {
        id: u64,
    },
}
impl Frame {
    fn encode(&self) -> io::Result<Vec<u8>> {
        use serde_json::json;
        let value = match self {
            Self::Ready => json!({"type":"ready"}),
            Self::Open {
                id,
                relay_version,
                identity,
            } => json!({"type":"open","id":id,"relay_version":relay_version,"identity":identity}),
            Self::Data { id, data } => json!({"type":"data","id":id,"data":data}),
            Self::Close { id } => json!({"type":"close","id":id}),
        };
        let mut bytes = serde_json::to_vec(&value)?;
        bytes.push(b'\n');
        Ok(bytes)
    }
    fn decode(line: &str) -> io::Result<Self> {
        let value: serde_json::Value = serde_json::from_str(line)?;
        let id = value["id"]
            .as_u64()
            .ok_or_else(|| error("missing connection id"))?;
        match value["type"].as_str() {
            Some("data") => Ok(Self::Data {
                id,
                data: value["data"]
                    .as_str()
                    .ok_or_else(|| error("missing data"))?
                    .into(),
            }),
            Some("close") => Ok(Self::Close { id }),
            _ => Err(error("invalid desktop command")),
        }
    }
}
// Two cancellable futures, without a procedural macro dependency. Dropping
// either losing future cancels its I/O. Neither branch is permanently biased.
enum Either<A, B> {
    Left(A),
    Right(B),
}
async fn select<A: std::future::Future, B: std::future::Future>(
    a: A,
    b: B,
) -> Either<A::Output, B::Output> {
    use std::{pin::pin, task::Poll};
    let mut a = pin!(a);
    let mut b = pin!(b);
    let mut left_first = true;
    std::future::poll_fn(move |cx| {
        left_first = !left_first;
        if left_first && let Poll::Ready(v) = a.as_mut().poll(cx) {
            return Poll::Ready(Either::Left(v));
        }
        if let Poll::Ready(v) = b.as_mut().poll(cx) {
            return Poll::Ready(Either::Right(v));
        }
        if !left_first && let Poll::Ready(v) = a.as_mut().poll(cx) {
            return Poll::Ready(Either::Left(v));
        }
        Poll::Pending
    })
    .await
}
fn error(message: impl Into<String>) -> io::Error {
    io::Error::other(message.into())
}
async fn line<R: tokio::io::AsyncRead + Unpin>(
    reader: &mut BufReader<R>,
    max: u64,
) -> io::Result<Option<String>> {
    let mut out = String::new();
    let count = reader.take(max).read_line(&mut out).await?;
    if count == 0 {
        return Ok(None);
    }
    if !out.ends_with('\n') {
        return Err(error("oversized or incomplete transport frame"));
    }
    Ok(Some(out))
}
async fn handshake(
    stream: &mut link::Stream,
    server: bool,
) -> io::Result<(String, Option<String>)> {
    tokio::time::timeout(Duration::from_secs(3), async {
        if !server {
            stream
                .write_all(
                    format!(
                        "{WIRE} {VERSION} {}\n",
                        std::env::var("PWRSNAP_MCP_TOKEN").unwrap_or_default()
                    )
                    .as_bytes(),
                )
                .await?;
        }
        // Read exactly through newline; do not consume subsequent MCP bytes.
        let mut bytes = Vec::new();
        loop {
            let b = stream.read_u8().await?;
            if b == b'\n' {
                break;
            }
            bytes.push(b);
            if bytes.len() >= 128 {
                return Err(error("invalid transport greeting"));
            }
        }
        let hello = String::from_utf8(bytes).map_err(|_| error("invalid transport greeting"))?;
        let mut fields = hello.split(' ');
        let wire = fields.next().unwrap_or_default();
        let version = fields.next().unwrap_or_default();
        let identity = fields.next().filter(|s| !s.is_empty()).map(str::to_owned);
        if wire != WIRE || version.is_empty() {
            return Err(error(
                "incompatible MCP transport; update the relay and desktop, then reconnect",
            ));
        }
        if server {
            stream
                .write_all(format!("{WIRE} {VERSION}\n").as_bytes())
                .await?;
        }
        Ok((version.to_owned(), identity))
    })
    .await?
}
async fn relay(path: &Path) -> io::Result<()> {
    // Exactly one connection. No reconnect, operation retries or fallback.
    let mut stream = link::connect(path).await?;
    let (desktop_transport, _) = handshake(&mut stream, false).await?;
    eprintln!(
        "pwrsnap-mcp relay {VERSION}; desktop transport {desktop_transport}; MCP interface/version is advertised by the desktop"
    );
    let (mut read, mut write) = tokio::io::split(stream);
    let mut input = tokio::io::stdin();
    let mut output = tokio::io::stdout();
    match select(
        tokio::io::copy(&mut input, &mut write),
        tokio::io::copy(&mut read, &mut output),
    )
    .await
    {
        Either::Left(result) => {
            result?;
        }
        Either::Right(result) => {
            result?;
            return Err(error("desktop or host disconnected"));
        }
    }
    // Closing stdio tears down the underlying connection immediately, even
    // on Windows where a pipe cannot half-close. No lingering drain task.
    Ok(())
}
async fn serve(path: &Path) -> io::Result<()> {
    let mut listener = link::Listener::bind(path)?;
    let (events, mut rx) = mpsc::channel::<Frame>(128);
    events
        .send(Frame::Ready)
        .await
        .map_err(|_| error("closed"))?;
    let mut writer = tokio::spawn(async move {
        let mut output = tokio::io::stdout();
        while let Some(event) = rx.recv().await {
            let bytes = event.encode()?;
            tokio::time::timeout(Duration::from_secs(2), output.write_all(&bytes)).await??;
        }
        Ok::<(), io::Error>(())
    });
    let mut input = BufReader::new(tokio::io::stdin());
    let mut peers = HashMap::<u64, (mpsc::Sender<Vec<u8>>, tokio::task::AbortHandle)>::new();
    let mut tasks = JoinSet::new();
    let mut next_id = 0;
    let result = loop {
        let joined = async {
            if tasks.is_empty() {
                std::future::pending().await
            } else {
                tasks.join_next().await
            }
        };
        let event = select(
            select(&mut writer, joined),
            select(line(&mut input, MAX_CONTROL), listener.accept()),
        )
        .await;
        match event {
            Either::Left(Either::Left(result)) => {
                break result.unwrap_or_else(|e| Err(error(e.to_string())));
            }
            Either::Left(Either::Right(joined)) => {
                if let Some(Ok(id)) = joined {
                    peers.remove(&id);
                    if events.send(Frame::Close { id }).await.is_err() {
                        break Err(error("desktop closed"));
                    }
                }
            }
            Either::Right(Either::Left(incoming)) => match incoming {
                Ok(Some(line)) => match Frame::decode(&line) {
                    Ok(Frame::Data { id, data }) => {
                        if let Some((tx, _)) = peers.get(&id) {
                            let accepted = match STANDARD.decode(data) {
                                Ok(bytes) if bytes.len() <= 16384 => tx.try_send(bytes).is_ok(),
                                _ => false,
                            };
                            if !accepted {
                                if let Some((_, task)) = peers.remove(&id) {
                                    task.abort();
                                }
                                let _ = events.send(Frame::Close { id }).await;
                            }
                        }
                    }
                    Ok(Frame::Close { id }) => {
                        if let Some((_, task)) = peers.remove(&id) {
                            task.abort();
                        }
                    }
                    _ => break Err(error("invalid desktop transport command")),
                },
                Ok(None) => break Ok(()),
                Err(e) => break Err(e),
            },
            Either::Right(Either::Right(accepted)) => {
                let Ok(mut stream) = accepted else {
                    continue;
                };
                if peers.len() >= MAX_PEERS {
                    continue;
                }
                next_id += 1;
                let id = next_id;
                let (tx, mut commands) = mpsc::channel::<Vec<u8>>(32);
                let events = events.clone();
                let task = tasks.spawn(async move {
                    let exchange = async {
                        let (version, identity) = handshake(&mut stream, true).await?;
                        events
                            .send(Frame::Open {
                                id,
                                relay_version: version,
                                identity,
                            })
                            .await
                            .map_err(|_| error("desktop closed"))?;
                        let (mut read, mut write) = tokio::io::split(stream);
                        let up = async {
                            let mut buf = [0_u8; 16384];
                            loop {
                                let n = read.read(&mut buf).await?;
                                if n == 0 {
                                    return Ok::<(), io::Error>(());
                                }
                                events
                                    .send(Frame::Data {
                                        id,
                                        data: STANDARD.encode(&buf[..n]),
                                    })
                                    .await
                                    .map_err(|_| error("desktop closed"))?;
                            }
                        };
                        let down = async {
                            while let Some(bytes) = commands.recv().await {
                                tokio::time::timeout(
                                    Duration::from_secs(2),
                                    write.write_all(&bytes),
                                )
                                .await??;
                            }
                            Ok::<(), io::Error>(())
                        };
                        match select(up, down).await {
                            Either::Left(result) | Either::Right(result) => result,
                        }
                    };
                    let _ = exchange.await;
                    id
                });
                peers.insert(id, (tx, task));
            }
        }
    };
    writer.abort();
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
    result
}
fn main() -> std::process::ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args == ["--version"] {
        println!("pwrsnap-mcp {VERSION} (transport 1)");
        return std::process::ExitCode::SUCCESS;
    }
    let listen = args.first().is_some_and(|s| s == "--desktop-listen");
    let rest = if listen { &args[1..] } else { &args[..] };
    let path = match rest {
        [] => link::endpoint(),
        [flag, value] if flag == "--endpoint" => Ok(value.into()),
        _ => Err(error("usage: pwrsnap-mcp [--endpoint PATH] | --version")),
    };
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("I/O runtime");
    let result = runtime.block_on(async {
        let path = path?;
        if listen {
            serve(&path).await
        } else {
            relay(&path).await
        }
    });
    runtime.shutdown_background();
    match result {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("pwrsnap-mcp: {e}. {MANUAL}");
            std::process::ExitCode::FAILURE
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
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
    fn mixed_releases_negotiate_transport_not_application_equality() {
        runtime().block_on(async {
            let dir = private_dir();
            let path = dir.path().join("mcp.sock");
            let mut listener = link::Listener::bind(&path).unwrap();
            let mut client = link::connect(&path).await.unwrap();
            let mut server = listener.accept().await.unwrap();
            client.write_all(b"PWRSNAP-MCP/1 0.0.1\n").await.unwrap();
            assert_eq!(
                handshake(&mut server, true).await.unwrap(),
                ("0.0.1".into(), None)
            );
            let mut ack = [0; 22];
            let n = client.read(&mut ack).await.unwrap();
            assert!(String::from_utf8_lossy(&ack[..n]).starts_with(WIRE));
        });
    }
    #[test]
    fn incompatible_transports_and_oversized_greetings_are_rejected() {
        runtime().block_on(async {
            for hello in ["PWRSNAP-MCP/9 1.0.0\n".to_owned(), "x".repeat(130)] {
                let dir = private_dir();
                let path = dir.path().join("mcp.sock");
                let mut listener = link::Listener::bind(&path).unwrap();
                let mut client = link::connect(&path).await.unwrap();
                let mut server = listener.accept().await.unwrap();
                client.write_all(hello.as_bytes()).await.unwrap();
                assert!(handshake(&mut server, true).await.is_err());
            }
        });
    }
}
