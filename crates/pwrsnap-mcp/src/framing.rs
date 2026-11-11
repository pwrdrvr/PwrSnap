//! One bounded decision per peer. HTTP bytes remain opaque after the request
//! line; the desktop's HTTP parser owns every subsequent byte and request.
use std::{io, time::Duration};
use tokio::io::{AsyncRead, AsyncReadExt};

#[derive(Debug, PartialEq)]
pub enum Greeting {
    Raw {
        version: String,
        identity: Option<String>,
        /// The PwrSnap role the client asked for (`pwrsnap-mcp --role`).
        role: Option<String>,
    },
    Http(Vec<u8>),
}
const MAX_LINE: usize = 4096;
/// A raw greeting: wire, version, optional identity and an optional
/// `role=<id>`. Room for a 43-character identity and a 64-character role.
const MAX_RAW: usize = 192;
const RAW_PREFIX: &[u8] = b"PWRSNAP-MCP/";
const METHODS: &[&[u8]] = &[
    b"GET ",
    b"POST ",
    b"DELETE ",
    b"OPTIONS ",
    b"HEAD ",
    b"PUT ",
    b"PATCH ",
];

pub async fn accept<R: AsyncRead + Unpin>(reader: &mut R, http: bool) -> io::Result<Greeting> {
    tokio::time::timeout(Duration::from_secs(3), detect(reader, http)).await?
}
async fn detect<R: AsyncRead + Unpin>(reader: &mut R, http: bool) -> io::Result<Greeting> {
    let mut bytes = Vec::new();
    loop {
        bytes.push(reader.read_u8().await?);
        let raw = RAW_PREFIX.starts_with(&bytes) || bytes.starts_with(RAW_PREFIX);
        let is_http = http
            && METHODS
                .iter()
                .any(|method| method.starts_with(&bytes) || bytes.starts_with(method));
        if (!raw && !is_http) || bytes.len() > MAX_LINE || (raw && bytes.len() >= MAX_RAW) {
            return Err(super::error("invalid or oversized IPC framing preamble"));
        }
        if bytes.last() != Some(&b'\n') {
            continue;
        }
        let line = std::str::from_utf8(&bytes).map_err(|_| super::error("invalid IPC framing"))?;
        if raw {
            let fields: Vec<_> = line.trim_end_matches('\n').split(' ').collect();
            if !(2..=4).contains(&fields.len())
                || fields[0] != super::WIRE
                || fields[1].is_empty()
                || fields
                    .iter()
                    .any(|s| s.bytes().any(|b| b.is_ascii_control()))
            {
                return Err(super::error(
                    "incompatible MCP transport; update the relay and desktop, then reconnect",
                ));
            }
            let role = match fields.get(3) {
                None => None,
                Some(field) => Some(
                    field
                        .strip_prefix("role=")
                        .filter(|role| super::valid_role(role))
                        .ok_or_else(|| super::error("invalid requested role"))?
                        .to_owned(),
                ),
            };
            return Ok(Greeting::Raw {
                version: fields[1].into(),
                identity: fields.get(2).filter(|s| !s.is_empty()).map(|s| (*s).into()),
                role,
            });
        }
        let fields: Vec<_> = line.strip_suffix("\r\n").unwrap_or("").split(' ').collect();
        if fields.len() != 3
            || !matches!(fields[2], "HTTP/1.0" | "HTTP/1.1")
            || !fields[1].starts_with('/')
            || fields[1].bytes().any(|b| !(0x21..=0x7e).contains(&b))
        {
            return Err(super::error("invalid HTTP/1.x request line"));
        }
        return Ok(Greeting::Http(bytes));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }
    #[test]
    fn fragmented_http_preserves_prefetched_and_following_bytes() {
        runtime().block_on(async {
            use tokio::io::AsyncWriteExt;
            for split in 1..28 {
                let (mut read, mut write) = tokio::io::duplex(256);
                let request = b"POST /mcp HTTP/1.1\r\nHost: local\r\n\r\n{}";
                let task =
                    tokio::spawn(async move { accept(&mut read, true).await.map(|g| (g, read)) });
                write.write_all(&request[..split]).await.unwrap();
                tokio::task::yield_now().await;
                write.write_all(&request[split..]).await.unwrap();
                drop(write);
                let (greeting, mut read) = task.await.unwrap().unwrap();
                let Greeting::Http(mut bytes) = greeting else {
                    panic!("HTTP expected")
                };
                read.read_to_end(&mut bytes).await.unwrap();
                assert_eq!(bytes, request);
            }
        });
    }
    #[test]
    fn strict_raw_identity_and_rejection_of_ambiguous_or_malformed_prefixes() {
        runtime().block_on(async {
            assert_eq!(
                accept(&mut &b"PWRSNAP-MCP/1 0.0.1 token\n"[..], true)
                    .await
                    .unwrap(),
                Greeting::Raw {
                    version: "0.0.1".into(),
                    identity: Some("token".into()),
                    role: None,
                }
            );
            assert_eq!(
                accept(
                    &mut &b"PWRSNAP-MCP/1 0.0.1  role=builtin.preview\n"[..],
                    true
                )
                .await
                .unwrap(),
                Greeting::Raw {
                    version: "0.0.1".into(),
                    identity: None,
                    role: Some("builtin.preview".into()),
                }
            );
            for line in ["POST /mcp HTTP/1.1\r\n", "GET / HTTP/1.0\r\n"] {
                assert!(accept(&mut line.as_bytes(), false).await.is_err());
            }
            for line in [
                "PWRSNAP-MCP/9 1\n",
                "PWRSNAP-MCP/1 1 token extra\n",
                "PWRSNAP-MCP/1 1 token role=\n",
                "PWRSNAP-MCP/1 1 token role=a/b\n",
                "PWRSNAP-MCP/1 1 token role=x extra\n",
                "POST / HTTP/2.0\r\n",
                "POST / HTTP/1.1\n",
                "POST  / HTTP/1.1\r\n",
                "GET http://host/ HTTP/1.1\r\n",
                "PRI * HTTP/2.0\r\n",
                "{",
                "POST",
                "PWR",
                "",
            ] {
                assert!(accept(&mut line.as_bytes(), true).await.is_err(), "{line}");
            }
            for line in [
                format!("POST /{}", "x".repeat(MAX_LINE)),
                format!("PWRSNAP-MCP/1 {}", "x".repeat(MAX_RAW)),
            ] {
                assert!(accept(&mut line.as_bytes(), true).await.is_err());
            }
        });
    }
    #[test]
    fn stalled_prefix_has_a_deadline_and_can_be_cancelled() {
        runtime().block_on(async {
            let (mut read, _write) = tokio::io::duplex(32);
            let started = std::time::Instant::now();
            assert!(accept(&mut read, true).await.is_err());
            assert!(started.elapsed() < Duration::from_secs(4));
            let (mut read, _write) = tokio::io::duplex(32);
            let task = tokio::spawn(async move { accept(&mut read, true).await });
            task.abort();
            assert!(task.await.unwrap_err().is_cancelled());
        });
    }
}
