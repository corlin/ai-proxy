import type {
  DesignPlanRequest,
  FlowerSnapshot,
  ImageGenerationRequest,
  UploadSlotRequest,
  VisualDesignRequest,
} from "./contracts";
import { HttpError } from "./http";

const supportedImageTypes = new Set(["image/jpeg", "image/png", "image/heic", "image/heif"]);

export function validateTenantId(tenantId: unknown): string {
  if (typeof tenantId !== "string" || tenantId.trim().length < 1 || tenantId.length > 120) {
    throw new HttpError(400, "invalid_tenant", "A valid tenantId is required.");
  }
  return tenantId.trim();
}

export function validateDesignPlanRequest(input: DesignPlanRequest): DesignPlanRequest {
  validateTenantId(input.tenantId);
  if (input.language !== "en" && input.language !== "zh") {
    throw new HttpError(400, "invalid_language", "Unsupported language.");
  }
  if (!input.request || typeof input.request !== "object") {
    throw new HttpError(400, "invalid_request", "Design request is required.");
  }
  if (!Array.isArray(input.inventory)) {
    throw new HttpError(400, "invalid_inventory", "Inventory must be an array.");
  }
  if (input.inventory.length > 500) {
    throw new HttpError(400, "invalid_inventory", "Inventory has too many items.");
  }
  input.inventory.forEach(validateFlower);
  return input;
}

export function validateVisualDesignRequest(input: VisualDesignRequest): VisualDesignRequest {
  validateDesignPlanRequest(input);
  if (typeof input.imageUploadId !== "string" || input.imageUploadId.length < 8) {
    throw new HttpError(400, "unsupported_image", "A valid imageUploadId is required.");
  }
  return input;
}

export function validateUploadSlotRequest(input: UploadSlotRequest): UploadSlotRequest {
  validateTenantId(input.tenantId);
  if (!supportedImageTypes.has(input.contentType)) {
    throw new HttpError(400, "unsupported_image", "Unsupported image content type.");
  }
  if (!Number.isInteger(input.byteCount) || input.byteCount <= 0 || input.byteCount > 12_000_000) {
    throw new HttpError(400, "unsupported_image", "Image must be 12 MB or smaller.");
  }
  return input;
}

export function validateImageGenerationRequest(
  input: ImageGenerationRequest,
): ImageGenerationRequest {
  validateTenantId(input.tenantId);
  if (typeof input.requestId !== "string" || input.requestId.length < 8) {
    throw new HttpError(400, "invalid_request", "A valid requestId is required.");
  }
  return input;
}

function validateFlower(flower: FlowerSnapshot): void {
  if (typeof flower.id !== "string" || flower.id.length < 1) {
    throw new HttpError(400, "invalid_inventory", "Each inventory item needs an id.");
  }
  if (typeof flower.name !== "string" || flower.name.trim().length < 1) {
    throw new HttpError(400, "invalid_inventory", "Each inventory item needs a name.");
  }
  if (!Number.isFinite(flower.quantity) || flower.quantity < 0) {
    throw new HttpError(400, "invalid_inventory", "Inventory quantity must be non-negative.");
  }
  if (!Number.isFinite(flower.unitCost) || !Number.isFinite(flower.retailPrice)) {
    throw new HttpError(400, "invalid_inventory", "Inventory pricing must be numeric.");
  }
}
