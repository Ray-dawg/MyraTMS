// ---------------------------------------------------------------------------
// SSE (Server-Sent Events) utility for MyraTMS
//
// Usage:
//   import { createSSEStream } from "@/lib/sse"
//   const { stream, writer } = createSSEStream()
//   writer.write("update", { lat: 41.88, lng: -87.63 })
//   writer.close()
//   return new Response(stream, { headers: { "Content-Type": "text/event-stream", ... } })
// ---------------------------------------------------------------------------

export function createSSEStream(onCancel?: () => void): {
  stream: ReadableStream
  writer: {
    write(event: string, data: unknown): void
    close(): void
  }
} {
  const encoder = new TextEncoder()
  let controller: ReadableStreamDefaultController | null = null

  const stream = new ReadableStream({
    start(ctrl) {
      controller = ctrl
    },
    cancel() {
      controller = null
      onCancel?.()
    },
  })

  const writer = {
    write(event: string, data: unknown) {
      if (!controller) return
      try {
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
        controller.enqueue(encoder.encode(payload))
      } catch {
        // stream may have been closed
      }
    },
    close() {
      if (!controller) return
      try {
        controller.close()
      } catch {
        // already closed
      }
      controller = null
    },
  }

  return { stream, writer }
}

/** Send a heartbeat comment to keep the SSE connection alive */
export function sseHeartbeat(writer: { write(event: string, data: unknown): void }): void {
  // Heartbeat is sent as a comment line (colon prefix), but since we use the writer
  // abstraction, we send it as a special event the client can ignore
  writer.write("heartbeat", { ts: new Date().toISOString() })
}
