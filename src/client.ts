/**
 * HTTP + WebSocket client for ComfyUI, aligned with current ComfyUI master
 * (https://github.com/comfyanonymous/ComfyUI, `server.py`).
 *
 * Improvements over the original version:
 * - Proper WebSocket error / close handling (`connect` rejects on failure).
 * - Handles `execution_error`, `execution_interrupted` and the new
 *   `execution_success` completion signal — promises no longer hang forever.
 * - Progress and per-node callbacks, optional timeout and AbortSignal.
 * - HTTPS / WSS support and Bearer API-token auth (multi-user servers).
 * - Newer endpoints: `POST /queue`, `POST /free`, `GET /stats`,
 *   `POST /object_info`, `GET /history?max_items=`, upload `type`/`subfolder`,
 *   `/view?channel=`.
 * - Typed, documented API surface with injectable logger.
 */

// Isomorphic build: no static Node-only imports. WebSocket is the platform
// global (native in browsers and Node >= 22); fs is dynamically imported by
// saveImages() only when actually called on Node.

import { ComfyUIClientError } from './types.js';
import type {
  BinaryPreview,
  ComfyUIClientEvent,
  ComfyUIClientOptions,
  EditHistoryRequest,
  ExecutionErrorData,
  ExecutionInterruptedData,
  ExecutionSuccessData,
  ExecutingData,
  FolderName,
  FreeRequest,
  GetImagesOptions,
  HistoryResult,
  FileContainer,
  ImagesResponse,
  ImageRef,
  LoggerLike,
  NodeOutput,
  ObjectInfoResponse,
  OutputFileRef,
  ProgressData,
  Prompt,
  PromptHistory,
  PromptQueueResponse,
  QueueMutationRequest,
  QueuePromptResult,
  QueueResponse,
  ResponseError,
  StatsResponse,
  SystemStatsResponse,
  UploadImageOptions,
  UploadImageResult,
  ViewMetadataResponse,
  ViewParams,
  WsMessage,
} from './types.js';

type EventHandler = (payload: unknown) => void;

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Parse the 8-byte little-endian header of a binary WS preview message.
 * Layout: eventType (u8), format (u8), width (u32 LE), height (u32 LE).
 */
function parseBinaryPreview(data: Uint8Array): BinaryPreview {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    header: {
      eventType: view.getUint8(0),
      format: view.getUint8(1),
      width: view.getUint32(2, /* littleEndian */ true),
      height: view.getUint32(6, /* littleEndian */ true),
    },
    payload: data.subarray(8),
  };
}

/** Normalise a WS message payload (Buffer / ArrayBuffer / string) to bytes. */
async function toUint8Array(data: unknown): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return data;
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }
  return new Uint8Array(data as ArrayBuffer);
}

/* ---------------------------------------------------------------------- */
/* Isomorphic WebSocket plumbing                                          */
/*                                                                        */
/* Two shapes are supported transparently:                                */
/*  - Node `ws` package (only when explicitly installed and apiToken      */
/*    auth over WS is needed): EventEmitter-style .on/.off/.removeAll-    */
/*    Listeners, Buffer payloads, ws.terminate().                         */
/*  - Platform global WebSocket (browsers, Electron renderer, Node >= 22):*/
/*    addEventListener/removeEventListener, ArrayBuffer/String payloads,   */
/*    no terminate (close is enough for a not-yet-open socket).           */
/* ---------------------------------------------------------------------- */

type AnyWs = { readyState?: number } & Record<string, any>;

function wsIsEventEmitter(ws: AnyWs): boolean {
  return typeof ws.on === 'function';
}

function createWebSocket(url: string, apiToken?: string): AnyWs {
  const WS = (globalThis as any).WebSocket;
  if (WS) {
    const ws = new WS(url) as AnyWs;
    // Browsers deliver binary frames as Blob by default; request ArrayBuffer
    // so the same Uint8Array path works on web and Node.
    if ('binaryType' in ws) ws.binaryType = 'arraybuffer';
    return ws;
  }
  // Node without global WebSocket: fall back to the `ws` package if present.
  // eval() keeps bundlers from statically resolving the import, so browser
  // builds never pull in `ws` (optional peer only).
  try {
    const wsMod = eval("require('ws')") as any;
    return new wsMod.default(url, {
      perMessageDeflate: false,
      ...(apiToken ? { headers: { Authorization: `Bearer ${apiToken}` } } : {}),
    });
  } catch {
    throw new ComfyUIClientError(
      'No WebSocket implementation available. This runtime has no global WebSocket; install the "ws" package.',
    );
  }
}

function addWsListener(
  ws: AnyWs,
  event: string,
  handler: (...args: any[]) => void,
): void {
  if (wsIsEventEmitter(ws)) ws.on(event, handler);
  else ws.addEventListener(event, (ev: any) => handler(ev?.data ?? ev));
}

function removeWsListener(
  ws: AnyWs,
  event: string,
  handler: (...args: any[]) => void,
): void {
  if (wsIsEventEmitter(ws)) ws.off(event, handler);
  else ws.removeEventListener(event, handler as EventListener);
}

function removeAllWsListeners(ws: AnyWs): void {
  if (wsIsEventEmitter(ws)) ws.removeAllListeners();
  else {
    // Native WS has no removeAllListeners; our listeners are also stored via
    // addEventListener wrappers. Dropping them is best-effort: disconnect()
    // closes the socket immediately after, and 'close'/'message' events on a
    // closed socket are harmless (handlers check this.ws identity).
    for (const t of ['open', 'close', 'error', 'message']) {
      const anyWs = ws as any;
      if (anyWs._artifyListeners?.[t]) {
        for (const l of anyWs._artifyListeners[t]) ws.removeEventListener(t, l);
      }
    }
  }
}

function closeHard(ws: AnyWs): void {
  if (typeof ws.terminate === 'function') ws.terminate();
  else ws.close();
}

export class ComfyUIClient {
  /** Host[:port] of the ComfyUI server, without scheme. */
  public serverAddress: string;
  /** Session/client id used for the WebSocket connection. */
  public clientId: string;

  protected ws?: AnyWs;
  protected httpBase: string;
  protected wsBase: string;
  protected apiToken?: string;
  protected requestTimeoutMs: number;
  protected logger: LoggerLike;
  protected handlers = new Map<ComfyUIClientEvent, Set<EventHandler>>();

  constructor(
    serverAddress: string,
    clientId: string,
    options: ComfyUIClientOptions = {},
  ) {
    this.serverAddress = serverAddress.replace(/^\w+:\/\//, '');
    this.clientId = clientId;
    this.apiToken = options.apiToken;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    // pino dropped from defaults: console satisfies LoggerLike everywhere.
    this.logger = options.logger ?? console;

    const secure = /^(https|wss):\/\//.test(serverAddress);
    this.httpBase = `http${secure ? 's' : ''}://${this.serverAddress}`;
    this.wsBase = `ws${secure ? 's' : ''}://${this.serverAddress}`;
  }

  /* ---------------------------------------------------------------------- */
  /* HTTP core                                                              */
  /* ---------------------------------------------------------------------- */

  /** Low-level JSON request with timeout, auth and error normalization. */
  protected async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const signal =
      this.requestTimeoutMs > 0
        ? AbortSignal.timeout(this.requestTimeoutMs)
        : undefined;

    let res: Response;
    try {
      res = await fetch(`${this.httpBase}${path}`, {
        ...init,
        signal: init.signal ?? signal,
        headers: {
          Accept: 'application/json',
          ...(init.body && !(init.body instanceof FormData)
            ? { 'Content-Type': 'application/json' }
            : {}),
          ...(this.apiToken
            ? { Authorization: `Bearer ${this.apiToken}` }
            : {}),
          ...(init.headers ?? {}),
        },
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new ComfyUIClientError(`Request to ${path} timed out`);
      }
      throw new ComfyUIClientError(
        `Request to ${path} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
      throw new ComfyUIClientError(
        `${path} responded ${res.status} ${res.statusText}`,
        {
          status: res.status,
          payload,
        },
      );
    }

    const body = (await res.json().catch(() => ({}))) as T;
    const candidate = body as unknown as ResponseError | undefined;
    if (
      candidate &&
      typeof candidate === 'object' &&
      'error' in candidate &&
      candidate.error !== undefined &&
      !(body as Record<string, unknown>).prompt_id
    ) {
      throw new ComfyUIClientError(`ComfyUI error on ${path}`, {
        status: res.status,
        payload: candidate,
      });
    }
    return body;
  }

  /* ---------------------------------------------------------------------- */
  /* WebSocket                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Open the WebSocket connection to `/ws?clientId=...`.
   * Rejects on connection failure or timeout.
   */
  connect(timeoutMs = 15_000): Promise<void> {
    this.disconnect();

    const url = `${this.wsBase}/ws?clientId=${encodeURIComponent(this.clientId)}`;
    this.logger.info({ url }, 'Connecting');

    // Bearer token over WS is only supported by the `ws` package (custom
    // headers). Native WebSocket cannot set headers; token-less connections
    // (the common local ComfyUI case) work identically on both.
    if (this.apiToken && typeof WebSocket === 'undefined') {
      return Promise.reject(
        new ComfyUIClientError(
          'apiToken over WebSocket requires a Node runtime',
        ),
      );
    }

    return new Promise((resolve, reject) => {
      const ws = createWebSocket(url, this.apiToken);
      this.ws = ws;

      const timer = setTimeout(() => {
        cleanup();
        closeHard(ws);
        if (this.ws === ws) this.ws = undefined;
        reject(
          new ComfyUIClientError(
            `WebSocket connection timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);

      const onOpen = () => {
        cleanup();
        this.logger.info('Connection open');
        resolve();
      };
      const onError = (ev: unknown) => {
        cleanup();
        if (this.ws === ws) this.ws = undefined;
        const msg = ev instanceof Event ? 'connection error' : String(ev);
        reject(new ComfyUIClientError(`WebSocket connection failed: ${msg}`));
      };
      const cleanup = () => {
        clearTimeout(timer);
        removeWsListener(ws, 'open', onOpen);
        removeWsListener(ws, 'error', onError);
      };

      addWsListener(ws, 'open', onOpen);
      addWsListener(ws, 'error', onError);

      addWsListener(ws, 'close', () => {
        this.logger.info('Connection closed');
        if (this.ws === ws) this.ws = undefined;
        this.emit('disconnected', undefined);
      });

      addWsListener(ws, 'message', async (data: unknown, isBinary: boolean) => {
        const looksBinary =
          isBinary ||
          data instanceof Uint8Array ||
          data instanceof ArrayBuffer ||
          (typeof Blob !== 'undefined' && data instanceof Blob);
        if (looksBinary) {
          try {
            const bytes = await toUint8Array(data);
            this.emit('preview', parseBinaryPreview(bytes));
          } catch {
            /* ignore malformed previews */
          }
          return;
        }
        let message: WsMessage;
        try {
          message = JSON.parse(String(data));
        } catch {
          return;
        }
        this.handleWsMessage(message);
      });
    });
  }

  /** Close the WebSocket connection (idempotent). */
  disconnect(): void {
    if (this.ws) {
      removeAllWsListeners(this.ws);
      this.ws.close();
      this.ws = undefined;
    }
  }

  /** Whether the WebSocket is currently open. */
  isConnected(): boolean {
    return this.ws?.readyState === /* WebSocket.OPEN */ 1;
  }

  private handleWsMessage(message: WsMessage): void {
    switch (message.type) {
      case 'status':
      case 'progress':
      case 'executing':
      case 'executing_cached':
      case 'execution_start':
      case 'execution_success':
      case 'execution_error':
      case 'execution_interrupted':
        this.emit(message.type as ComfyUIClientEvent, message.data);
        break;
      default:
        this.logger.debug({ type: message.type }, 'Unhandled WS message');
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Event emitter                                                          */
  /* ---------------------------------------------------------------------- */

  /** Subscribe to a WebSocket event (see {@link ComfyUIClientEvent}). */
  on(event: ComfyUIClientEvent, handler: EventHandler): this {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
    return this;
  }

  /** Unsubscribe from an event. */
  off(event: ComfyUIClientEvent, handler: EventHandler): this {
    this.handlers.get(event)?.delete(handler);
    return this;
  }

  private emit(event: ComfyUIClientEvent, payload: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) {
      try {
        handler(payload);
      } catch (err) {
        this.logger.error({ err, event }, 'Event handler threw');
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Endpoints                                                              */
  /* ---------------------------------------------------------------------- */

  /** `GET /embeddings` — available embedding names. */
  async getEmbeddings(): Promise<string[]> {
    return this.request<string[]>('/embeddings');
  }

  /** `GET /extensions` — enabled extensions. */
  async getExtensions(): Promise<string[]> {
    return this.request<string[]>('/extensions');
  }

  /** `GET /system_stats` — system, ComfyUI version and device info. */
  async getSystemStats(): Promise<SystemStatsResponse> {
    return this.request<SystemStatsResponse>('/system_stats');
  }

  /** `GET /stats` — live sampled metrics (newer servers). */
  async getStats(): Promise<StatsResponse> {
    return this.request<StatsResponse>('/stats');
  }

  /** `GET /prompt` — current queue remaining count. */
  async getPrompt(): Promise<PromptQueueResponse> {
    return this.request<PromptQueueResponse>('/prompt');
  }

  /**
   * `POST /prompt` — queue a workflow (API format) for execution.
   * Validation failures throw with `node_errors` in the error payload.
   */
  async queuePrompt(prompt: Prompt): Promise<QueuePromptResult> {
    return this.request<QueuePromptResult>('/prompt', {
      method: 'POST',
      body: JSON.stringify({ prompt, client_id: this.clientId }),
    });
  }

  /** `POST /interrupt` — interrupt the currently running prompt. */
  async interrupt(): Promise<void> {
    await this.request<unknown>('/interrupt', { method: 'POST' });
  }

  /** `GET /queue` — running and pending queue entries. */
  async getQueue(): Promise<QueueResponse> {
    return this.request<QueueResponse>('/queue');
  }

  /** `POST /queue` — clear the queue or delete specific prompt ids. */
  async editQueue(params: QueueMutationRequest): Promise<void> {
    await this.request<unknown>('/queue', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  /** `POST /free` — unload models and/or free intermediate caches. */
  async freeMemory(params: FreeRequest): Promise<void> {
    await this.request<unknown>('/free', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  /**
   * `GET /history[/{promptId}]` — execution history.
   * Result keys are **prompt ids**. `maxItems` limits history size.
   */
  async getHistory(
    promptId?: string,
    maxItems?: number,
  ): Promise<HistoryResult> {
    const search = maxItems !== undefined ? `?max_items=${maxItems}` : '';
    return this.request<HistoryResult>(
      `/history${promptId ? `/${promptId}` : ''}${search}`,
    );
  }

  /** `POST /history` — clear or delete history entries. */
  async editHistory(params: EditHistoryRequest): Promise<void> {
    await this.request<unknown>('/history', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  /** `GET /object_info[/{nodeClass}]` — node definitions (can be large). */
  async getObjectInfo(nodeClass?: string): Promise<ObjectInfoResponse> {
    return this.request<ObjectInfoResponse>(
      `/object_info${nodeClass ? `/${nodeClass}` : ''}`,
    );
  }

  /**
   * `POST /object_info` — fetch node definitions for a subset of node classes
   * (newer servers; avoids the multi-MB full listing).
   */
  async getObjectInfoFor(nodeClasses: string[]): Promise<ObjectInfoResponse> {
    return this.request<ObjectInfoResponse>('/object_info', {
      method: 'POST',
      body: JSON.stringify(nodeClasses),
    });
  }

  /** `GET /view_metadata/{folder}` — model metadata (e.g. checkpoint notes). */
  async viewMetadata(
    folderName: FolderName,
    filename: string,
  ): Promise<ViewMetadataResponse> {
    return this.request<ViewMetadataResponse>(
      `/view_metadata/${folderName}?filename=${encodeURIComponent(filename)}`,
    );
  }

  /**
   * `GET /view` — download an output/temp/input file.
   * Accepts either a {@link ViewParams} object or positional
   * `(filename, subfolder, type)` for backwards compatibility.
   */
  async getImage(
    params: ViewParams | string,
    subfolder?: string,
    type?: string,
  ): Promise<Blob> {
    const p: ViewParams =
      typeof params === 'string'
        ? { filename: params, subfolder, type }
        : params;
    const query = new URLSearchParams({
      filename: p.filename,
      subfolder: p.subfolder ?? '',
      type: p.type ?? 'output',
    });
    if (p.channel) query.set('channel', p.channel);
    if (p.download) query.set('download', 'true');

    const headers: Record<string, string> = {};
    if (this.apiToken) headers.Authorization = `Bearer ${this.apiToken}`;

    let res: Response;
    try {
      res = await fetch(`${this.httpBase}/view?${query}`, { headers });
    } catch (err) {
      throw new ComfyUIClientError(
        `/view request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      throw new ComfyUIClientError(`/view responded ${res.status}`, {
        status: res.status,
      });
    }
    return res.blob();
  }

  /**
   * `POST /upload/image`. The third argument also accepts a plain boolean
   * (`overwrite`) for backwards compatibility.
   */
  async uploadImage(
    image: Uint8Array,
    filename: string,
    optionsOrOverwrite?: UploadImageOptions | boolean,
  ): Promise<UploadImageResult> {
    const options: UploadImageOptions =
      typeof optionsOrOverwrite === 'boolean'
        ? { overwrite: optionsOrOverwrite }
        : optionsOrOverwrite ?? {};
    return this.uploadFile('/upload/image', image, filename, options);
  }

  /** `POST /upload/mask`. Pass `options.originalRef` for alpha masks. */
  async uploadMask(
    image: Uint8Array,
    filename: string,
    originalRef: ImageRef,
    optionsOrOverwrite?: UploadImageOptions | boolean,
  ): Promise<UploadImageResult> {
    const options: UploadImageOptions =
      typeof optionsOrOverwrite === 'boolean'
        ? { overwrite: optionsOrOverwrite }
        : optionsOrOverwrite ?? {};
    return this.uploadFile('/upload/mask', image, filename, {
      ...options,
      originalRef,
    });
  }

  private async uploadFile(
    path: string,
    image: Uint8Array,
    filename: string,
    options: UploadImageOptions,
  ): Promise<UploadImageResult> {
    const formData = new FormData();
    formData.append('image', new Blob([image]), filename);
    if (options.overwrite) formData.append('overwrite', 'true');
    if (options.type) formData.append('type', options.type);
    if (options.subfolder) formData.append('subfolder', options.subfolder);
    if (options.originalRef)
      formData.append('originalRef', JSON.stringify(options.originalRef));

    const headers: Record<string, string> = {};
    if (this.apiToken) headers.Authorization = `Bearer ${this.apiToken}`;

    const res = await fetch(`${this.httpBase}${path}`, {
      method: 'POST',
      body: formData,
      headers,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ComfyUIClientError(`${path} responded ${res.status}`, {
        status: res.status,
        payload: text,
      });
    }
    return (await res.json()) as UploadImageResult;
  }

  /* ---------------------------------------------------------------------- */
  /* High-level helpers                                                     */
  /* ---------------------------------------------------------------------- */

  /**
   * Queue a prompt, wait for completion and download image outputs.
   *
   * Resolves on `execution_success` (new servers) or the legacy
   * `executing` with `node === null` signal; rejects on `execution_error`,
   * `execution_interrupted`, WebSocket disconnect, timeout or abort.
   */
  async getImages(
    prompt: Prompt,
    options: GetImagesOptions = {},
  ): Promise<ImagesResponse> {
    const outputs = await this.getOutputs(prompt, options);
    const result: ImagesResponse = {};
    for (const [nodeId, files] of Object.entries(outputs)) {
      const images = files.filter((f) => this.isImageRef(f.image));
      if (images.length > 0) result[nodeId] = images;
    }
    return result;
  }

  /**
   * Like {@link getImages} but downloads every output kind
   * (images, videos, audio).
   */
  async getOutputs(
    prompt: Prompt,
    options: GetImagesOptions = {},
  ): Promise<Record<string, FileContainer[]>> {
    const history = await this.waitForPrompt(prompt, options);
    return this.downloadOutputs(history.outputs);
  }

  /**
   * Queue a prompt and wait for completion, resolving with its history entry
   * (outputs are not downloaded).
   */
  async waitForPrompt(
    prompt: Prompt,
    options: GetImagesOptions = {},
  ): Promise<PromptHistory> {
    if (!this.ws) {
      throw new Error(
        'WebSocket client is not connected. Please call connect() first.',
      );
    }

    const queue = await this.queuePrompt(prompt);
    const promptId = queue.prompt_id;

    return new Promise<PromptHistory>((resolve, reject) => {
      let settled = false;

      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        this.off('execution_success', onSuccess);
        this.off('executing', onExecuting);
        this.off('progress', onProgress);
        this.off('execution_error', onError);
        this.off('execution_interrupted', onInterrupted);
        this.off('disconnected', onDisconnected);
        options.signal?.removeEventListener('abort', onAbort);
      };

      const finish = (ok: boolean, err?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (!ok) {
          reject(err ?? new ComfyUIClientError('Execution failed'));
          return;
        }
        // Fetch history; retry briefly in case the server has not flushed yet.
        void (async () => {
          try {
            let entry: PromptHistory | undefined;
            for (let attempt = 0; attempt < 10 && !entry; attempt++) {
              if (attempt > 0) await new Promise((r) => setTimeout(r, 200));
              entry = (await this.getHistory(promptId))[promptId];
            }
            if (!entry) {
              reject(
                new ComfyUIClientError(`History for ${promptId} not found`),
              );
            } else {
              resolve(entry);
            }
          } catch (e) {
            reject(e instanceof Error ? e : new ComfyUIClientError(String(e)));
          }
        })();
      };

      const matches = (data: { prompt_id?: string }) =>
        data.prompt_id === undefined || data.prompt_id === promptId;

      const onSuccess = (data: unknown) => {
        if (matches(data as ExecutionSuccessData)) finish(true);
      };

      const onExecuting = (data: unknown) => {
        const d = data as ExecutingData;
        if (!matches(d)) return;
        options.onExecuting?.(d);
        // Legacy completion signal: `executing` with node === null.
        if (d.node === null || d.node === undefined) finish(true);
      };

      const onProgress = (data: unknown) => {
        const d = data as ProgressData;
        if (matches(d)) options.onProgress?.(d);
      };

      const onError = (data: unknown) => {
        const d = data as ExecutionErrorData;
        if (!matches(d)) return;
        finish(
          false,
          new ComfyUIClientError(
            `Execution failed at node ${d.node_id} (${d.node_type}): ${d.exception_message}`,
            { payload: d },
          ),
        );
      };

      const onInterrupted = (data: unknown) => {
        const d = data as ExecutionInterruptedData;
        if (!matches(d)) return;
        finish(
          false,
          new ComfyUIClientError('Execution interrupted', { payload: d }),
        );
      };

      const onDisconnected = () => {
        finish(
          false,
          new ComfyUIClientError('WebSocket disconnected while waiting'),
        );
      };

      const onAbort = () => finish(false, new ComfyUIClientError('Aborted'));

      const timer =
        options.timeoutMs && options.timeoutMs > 0
          ? setTimeout(
              () =>
                finish(
                  false,
                  new ComfyUIClientError(
                    `Prompt timed out after ${options.timeoutMs}ms`,
                  ),
                ),
              options.timeoutMs,
            )
          : undefined;

      this.on('execution_success', onSuccess);
      this.on('executing', onExecuting);
      this.on('progress', onProgress);
      this.on('execution_error', onError);
      this.on('execution_interrupted', onInterrupted);
      this.on('disconnected', onDisconnected);
      options.signal?.addEventListener('abort', onAbort);
    });
  }

  /** Download all files referenced by history node outputs (in parallel). */
  protected async downloadOutputs(
    outputs: Record<string, NodeOutput>,
  ): Promise<Record<string, FileContainer[]>> {
    const result: Record<string, FileContainer[]> = {};
    const jobs: Array<Promise<void>> = [];

    for (const [nodeId, nodeOutput] of Object.entries(outputs)) {
      const refs: OutputFileRef[] = [
        ...(nodeOutput.images ?? []),
        ...(nodeOutput.videos ?? nodeOutput.gifs ?? []),
        ...(nodeOutput.audio ?? []),
      ];
      if (refs.length === 0) continue;
      result[nodeId] = [];
      for (const ref of refs) {
        jobs.push(
          (async () => {
            const blob = await this.getImage(
              ref.filename,
              ref.subfolder,
              ref.type,
            );
            result[nodeId].push({ blob, image: ref });
          })(),
        );
      }
    }
    await Promise.all(jobs);
    return result;
  }

  /** Heuristic: is this history ref an image (vs video/audio)? */
  private isImageRef(ref: OutputFileRef): boolean {
    if (ref.format) return ref.format.startsWith('image/');
    return !/\.(mp4|webm|mkv|mp3|wav|flac|ogg|m4a)$/i.test(ref.filename);
  }

  /**
   * Save downloaded outputs to disk in parallel, preserving subfolders.
   * Node-only: `fs` is imported dynamically so browser bundles never pull it in.
   */
  async saveImages(response: ImagesResponse, outputDir: string): Promise<void> {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const jobs: Array<Promise<void>> = [];
    for (const files of Object.values(response)) {
      for (const img of files) {
        jobs.push(
          (async () => {
            const dir = join(outputDir, img.image.subfolder);
            await mkdir(dir, { recursive: true });
            await writeFile(
              join(dir, img.image.filename),
              new Uint8Array(await img.blob.arrayBuffer()),
            );
          })(),
        );
      }
    }
    await Promise.all(jobs);
  }
}
