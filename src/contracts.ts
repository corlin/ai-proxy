export type LanguageCode = "en" | "zh";

export interface DesignRequest {
  id: string;
  occasion: string;
  recipient: string;
  style: string;
  colorPalette?: string | null;
  format?: string | null;
  budget?: number | null;
  requirements?: string | null;
  school?: string | null;
  technique?: string | null;
  designMode?: string | null;
  proportionRule?: string | null;
  seasonality?: string | null;
  culturalContext?: string | null;
  scalePreference?: string | null;
  moodPreference?: string | null;
  formPreference?: string | null;
  backgroundStyle?: string | null;
}

export interface FlowerSnapshot {
  id: string;
  name: string;
  color: string;
  quantity: number;
  category: string;
  unitCost: number;
  retailPrice: number;
  meaning?: string | null;
  cultureTags: string[];
}

export interface DesignPlanRequest {
  tenantId: string;
  language: LanguageCode;
  request: DesignRequest;
  inventory: FlowerSnapshot[];
}

export interface VisualDesignRequest extends DesignPlanRequest {
  imageUploadId: string;
}

export interface UploadSlotRequest {
  tenantId: string;
  contentType: string;
  byteCount: number;
}

export interface ImageGenerationRequest {
  tenantId: string;
  requestId: string;
}

export interface DesignFlowerItem {
  flowerName: string;
  count: number;
  reason?: string;
}

export interface DesignResponse {
  requestId: string;
  title: string;
  description: string;
  meaningText: string;
  reasoning?: string;
  steps: string[];
  imagePrompt?: string;
  estimatedCost?: number;
  flowerList: DesignFlowerItem[];
}

export interface UploadSlot {
  uploadId: string;
  uploadUrl: string;
  expiresAt: number;
}

export type JobStatusValue = "queued" | "running" | "succeeded" | "failed";

export interface JobStatus {
  jobId: string;
  status: JobStatusValue;
  pollAfterSeconds?: number;
  result?: DesignResponse;
  imageUrl?: string;
  error?: ErrorResponse;
}

export interface ErrorResponse {
  requestId?: string;
  code: string;
  message: string;
}

export type JobKind = "visual_design" | "image_generation";

export interface QueueJobMessage {
  jobId: string;
  tenantId: string;
  kind: JobKind;
}
