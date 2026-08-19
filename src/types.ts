/**
 * Type definitions for the ComfyUI HTTP/WebSocket API.
 *
 * Shapes are aligned with ComfyUI master
 * (https://github.com/comfyanonymous/ComfyUI), in particular
 * `server.py` and `execution.py`.
 */

/* -------------------------------------------------------------------------- */
/* Prompt (workflow graph)                                                     */
/* -------------------------------------------------------------------------- */

/** A single node inside a prompt (workflow graph). */
export interface NodeInput {
  /** Node class, e.g. `"KSampler"`, `"CheckpointLoaderSimple"`. */
  class_type: string;
  /** Input values; references to other nodes use `[nodeId, outputSlot]`. */
  inputs: Record<string, unknown>;
  /** Optional metadata (node title in the UI). Newer ComfyUI versions emit this. */
  _meta?: {
    title?: string;
  };
}

/**
 * An API-format workflow: a map of node id -> node definition.
 * Export from the ComfyUI UI via "Save (API Format)".
 */
export type Prompt = Record<string, NodeInput>;

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

/** A structured error returned by ComfyUI for a whole prompt or a single node. */
export interface ComfyUIError {
  type: string;
  message: string;
  /** Human-readable details (often contains the traceback summary). */
  details: string;
  /** Arbitrary extra info, e.g. `{ node_id, node_type, ... }` for node errors. */
  extra_info?: Record<string, unknown>;
}

/** Response body of failed `/prompt`, `/interrupt`, etc. calls. */
export interface ResponseError {
  error: string | ComfyUIError;
  node_errors?: Record<string, ComfyUIError[]>;
}

/** Thrown by all client methods when the server responds with an error. */
export class ComfyUIClientError extends Error {
  /** HTTP status code, when the failure came from a HTTP response. */
  readonly status?: number;
  /** Raw (parsed) error payload from the server, when available. */
  readonly payload?: unknown;

  constructor(
    message: string,
    options?: { status?: number; payload?: unknown },
  ) {
    super(message);
    this.name = 'ComfyUIClientError';
    this.status = options?.status;
    this.payload = options?.payload;
  }
}

/* -------------------------------------------------------------------------- */
/* /prompt, /queue, /free                                                      */
/* -------------------------------------------------------------------------- */

/** Result of successfully queueing a prompt via `POST /prompt`. */
export interface QueuePromptResult {
  prompt_id: string;
  /** Position in the queue; `0` when running immediately. */
  number: number | null;
  /** Node validation errors; non-empty means the prompt was NOT queued. */
  node_errors: Record<string, ComfyUIError[]>;
  /** Present on newer servers (workflow deployments). */
  deploy?: unknown;
}

/** Response of `GET /prompt` — number of prompts currently pending. */
export interface PromptQueueResponse {
  exec_info: { queue_remaining: number };
}

/** Response of `GET /queue`. */
export interface QueueResponse {
  queue_running: unknown[];
  queue_pending: unknown[];
}

/** Body for `POST /queue` (delete items or clear the queue). */
export interface QueueMutationRequest {
  /** Clear the whole queue. */
  clear?: boolean;
  /** Delete specific prompt ids. */
  delete?: string[];
  /** Delete items while their output already exists (history prune helper). */
  delete_iterative?: unknown[];
}

/** Body for `POST /free` (memory management). */
export interface FreeRequest {
  /** Unload models from VRAM. */
  unload_models?: boolean;
  /** Free intermediate output caches. */
  free_memory?: boolean;
}

/* -------------------------------------------------------------------------- */
/* /history                                                                    */
/* -------------------------------------------------------------------------- */

/** One file entry produced by a node (image / video / audio share this shape). */
export interface OutputFileRef {
  filename: string;
  subfolder: string;
  type: 'output' | 'temp' | 'input';
  /** For animated outputs: mime type, e.g. `"image/gif"` or `"video/h264-mp4"`. */
  format?: string;
  /** Extra format metadata (frame rate, lossy flags, ...). */
  extra?: Record<string, unknown>;
}

/** Outputs of a single node, as stored in history. */
export interface NodeOutput {
  images?: OutputFileRef[];
  /** Animated outputs; renamed from `gifs` in newer ComfyUI. */
  videos?: OutputFileRef[];
  /** Legacy alias still emitted by some versions/custom nodes. */
  gifs?: OutputFileRef[];
  audio?: OutputFileRef[];
  /** Text outputs (e.g. ShowText custom nodes). */
  text?: Array<{ caption: string; text?: unknown }>;
}

/** Status block attached to a prompt in history (ComfyUI >= 2024-08). */
export interface PromptStatus {
  /** `"success"` | `"error"` | `"cancelled"`. */
  status_str: string;
  completed: boolean;
  /** Status message history, e.g. validation / execution messages. */
  messages: Array<[string, Record<string, unknown>]>;
}

/** A full history entry for one executed prompt. */
export interface PromptHistory {
  prompt: unknown[];
  outputs: Record<string, NodeOutput>;
  status?: PromptStatus;
  /** Meta info: prompt id, seed, execution time, ... */
  meta?: Record<string, unknown>;
}

/**
 * Response of `GET /history` / `GET /history/{prompt_id}`.
 * Keys are **prompt ids** (not client ids).
 */
export type HistoryResult = Record<string, PromptHistory>;

/** Body for `POST /history` (clear / delete entries). */
export interface EditHistoryRequest {
  clear?: boolean;
  delete?: string[];
}

/* -------------------------------------------------------------------------- */
/* Images / uploads / view                                                     */
/* -------------------------------------------------------------------------- */

/** Result of `POST /upload/image` and `POST /upload/mask`. */
export interface UploadImageResult {
  name: string;
  subfolder: string;
  type: string;
}

/** Reference to an uploaded file (used e.g. by LoadImage node inputs). */
export interface ImageRef {
  filename: string;
  subfolder?: string;
  type?: string;
}

/** Upload options accepted by newer ComfyUI servers. */
export interface UploadImageOptions {
  /** Overwrite existing file. Default: false. */
  overwrite?: boolean;
  /** Target folder type: `input` (default) | `temp` | `output`. */
  type?: 'input' | 'temp' | 'output';
  /** Target subfolder inside the folder type. */
  subfolder?: string;
  /** For masks: reference to the original image the mask belongs to. */
  originalRef?: ImageRef;
}

/** Query params for `GET /view` (download an output/input/temp file). */
export interface ViewParams {
  filename: string;
  subfolder?: string;
  type?: string;
  /** Preview channel for latent decodes: `rgb` | `rgba` | `a` | `depth` ... */
  channel?: string;
  /** Whether to send a content-disposition attachment header. */
  download?: boolean;
}

/** A downloaded file together with its server-side reference. */
export interface FileContainer {
  blob: Blob;
  image: OutputFileRef;
}

/** All outputs of a prompt, keyed by node id. */
export type ImagesResponse = Record<string, FileContainer[]>;

/* -------------------------------------------------------------------------- */
/* /system_stats, /stats, /embeddings, /extensions                             */
/* -------------------------------------------------------------------------- */

export interface DeviceStats {
  name: string;
  type: string;
  index: number;
  vram_total: number;
  vram_free: number;
  torch_vram_total: number;
  torch_vram_free: number;
}

/** Response of `GET /system_stats`. */
export interface SystemStatsResponse {
  system: {
    os: string;
    ram_total: number;
    ram_free: number;
    comfyui_version: string;
    python_version: string;
    argv: string[];
  };
  devices: DeviceStats[];
}

/** Response of `GET /stats` (newer servers; live metric sampling). */
export interface StatsResponse {
  system?: Record<string, unknown>;
  devices?: Record<string, Record<string, unknown>>;
}

/* -------------------------------------------------------------------------- */
/* /object_info                                                                */
/* -------------------------------------------------------------------------- */

export interface ObjectInfo {
  name: string;
  display_name: string;
  description: string;
  category: string;
  input: Record<string, unknown>;
  output: string[];
  output_is_list: boolean[];
  output_name: string[];
  output_node: boolean;
}

/** Response of `GET /object_info[/{node_class}]`. */
export type ObjectInfoResponse = Record<string, ObjectInfo>;

/**
 * Folder names accepted by `/view_metadata/{folder}`.
 * Newer ComfyUI registers extra folders dynamically (ultralytics,
 * photomaker, ipadapter, ...), so this union also accepts any string.
 */
export type FolderName =
  | 'checkpoints'
  | 'configs'
  | 'loras'
  | 'vae'
  | 'clip'
  | 'unet'
  | 'clip_vision'
  | 'style_models'
  | 'embeddings'
  | 'diffusers'
  | 'vae_approx'
  | 'controlnet'
  | 'gligen'
  | 'upscale_models'
  | 'custom_nodes'
  | 'hypernetworks'
  | 'ultralytics'
  | 'photomaker'
  | 'ipadapter'
  | (string & {});

/** Response of `GET /view_metadata/{folder}` — model card metadata. */
export type ViewMetadataResponse = Record<string, unknown>;

/* -------------------------------------------------------------------------- */
/* WebSocket messages                                                          */
/* -------------------------------------------------------------------------- */

/** Envelope of every JSON message received on `/ws`. */
export interface WsMessage<T = Record<string, unknown>> {
  type: string;
  data: T;
  /** Present on `status` messages: the session id. */
  sid?: string;
}

export interface ExecutionStartData {
  prompt_id: string;
}

export interface ExecutingData {
  prompt_id: string;
  /** Node id currently executing; `null` when the prompt finished. */
  node?: string | null;
  /** Node display name (newer servers). */
  display_node?: string;
  /** Node type (newer servers). */
  node_type?: string;
}

export interface ProgressData {
  prompt_id?: string;
  value: number;
  max: number;
  /** Present when the progress message carries preview images. */
  prompt?: unknown[];
  extra_data?: Record<string, unknown>;
}

export interface ExecutingCachedData {
  prompt_id: string;
  nodes: string[];
}

/** `status` message (sent on connect and on queue changes). */
export interface StatusData {
  status: { exec_info: { queue_remaining: number } };
}

/** `execution_success` data (ComfyUI >= 2024-10). */
export interface ExecutionSuccessData {
  prompt_id: string;
}

/** `execution_error` data. */
export interface ExecutionErrorData {
  prompt_id: string;
  node_type: string;
  node_id: string;
  executed_node?: string;
  exception_message: string;
  exception_type: string;
  traceback: string[];
  current_node_input?: Record<string, unknown>;
}

/** `execution_interrupted` data. */
export interface ExecutionInterruptedData {
  prompt_id: string;
  node_id?: string;
  node_type?: string;
}

/** Parsed 8-byte little-endian header of binary WS preview messages. */
export interface BinaryPreviewHeader {
  /** Event type: 0 = preview image, 1 = progress info. */
  eventType: number;
  /** Format code: 1 = JPEG, 2 = PNG, 3 = raw 16-bit, 4 = raw 8-bit. */
  format: number;
  width: number;
  height: number;
}

/** A parsed binary preview message. */
export interface BinaryPreview {
  header: BinaryPreviewHeader;
  /** Image bytes (when eventType === 0), without the 8-byte header. */
  payload: Uint8Array;
}

/* -------------------------------------------------------------------------- */
/* Client options                                                              */
/* -------------------------------------------------------------------------- */

/** Minimal pino-like logger interface (pino, winston, console all satisfy it). */
export interface LoggerLike {
  info: (objOrMsg: unknown, msg?: string) => void;
  warn: (objOrMsg: unknown, msg?: string) => void;
  error: (objOrMsg: unknown, msg?: string) => void;
  debug: (objOrMsg: unknown, msg?: string) => void;
}

/** Options accepted by the `ComfyUIClient` constructor. */
export interface ComfyUIClientOptions {
  /**
   * Server base, e.g. `"127.0.0.1:8188"`. May include a scheme
   * (`http://`/`https://`); `ws://`/`wss://` is derived automatically.
   */
  serverAddress?: string;
  /** Client/session id sent as `clientId` query param on the WS. */
  clientId?: string;
  /** API token; sent as `Authorization: Bearer <token>` (multi-user servers). */
  apiToken?: string;
  /** Default timeout (ms) for HTTP requests. Default: 60000. */
  requestTimeoutMs?: number;
  /**
   * Logger. Pass any pino-like object or `console`.
   * Default: pino at `info` level.
   */
  logger?: LoggerLike;
}

/** Options for `getImages()` / `getOutputs()`. */
export interface GetImagesOptions {
  /** Overall timeout for prompt execution (ms). Default: 0 = no timeout. */
  timeoutMs?: number;
  /** Called on every `progress` WS message. */
  onProgress?: (progress: ProgressData) => void;
  /** Called when a node starts executing; `node === null` means prompt done. */
  onExecuting?: (data: ExecutingData) => void;
  /** AbortSignal to cancel waiting (does NOT stop server-side execution). */
  signal?: AbortSignal;
}

/** Events emitted by `ComfyUIClient` via `on()` / `off()`. */
export type ComfyUIClientEvent =
  | 'status'
  | 'progress'
  | 'executing'
  | 'executing_cached'
  | 'execution_start'
  | 'execution_success'
  | 'execution_error'
  | 'execution_interrupted'
  | 'preview'
  | 'disconnected';
