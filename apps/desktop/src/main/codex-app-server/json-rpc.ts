// JSON-RPC core — now sourced from @pwrdrvr/agent-transport.
//
// This file was a near-verbatim lift of PwrAgnt's JSON-RPC 2.0 client/server.
// That logic now lives in the shared @pwrdrvr/agent-transport package; this
// module re-exports it so the in-tree consumers (codex-thread-client.ts,
// codex-client.ts, and their tests) keep a single import path while the
// duplicated implementation is gone. The renderer-side chat swap + final
// deletion of this shim is a later pass (consume-agent-kit plan U3/U4).

export {
  JsonRpcConnection,
  StdioJsonRpcTransport,
  type JsonRpcConnectionOptions,
  type JsonRpcId,
  type JsonRpcNotificationHandler,
  type JsonRpcObserver,
  type JsonRpcObserverDiagnostics,
  type JsonRpcObserverEvent,
  type JsonRpcRequestHandler,
  type JsonRpcTransport
} from "@pwrdrvr/agent-transport";
