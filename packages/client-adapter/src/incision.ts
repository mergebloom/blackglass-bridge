export const REVIEWED_RANGE_SCHEMA_VERSION = 1;

export interface ReviewedRange {
  id: string;
  file: string;
  offset: number;
  length: number;
  sha256: string;
}

export type RendererReplacement =
  | "control-origin"
  | "data-host-guard"
  | "cli-socket"
  | "cli-runtime-home"
  | "cli-registration";

export interface RendererIncision extends ReviewedRange {
  replacement: RendererReplacement;
}

export type WrapperReplacement =
  | "profile-bootstrap"
  | "disable-updater"
  | "embedded-renderer-only";

export interface WrapperIncision extends ReviewedRange {
  replacement: WrapperReplacement;
}

export interface RendererRuntimeContract {
  wrapperRendererArguments: 2;
  rendererDevModeArgument: 3 | null;
}
