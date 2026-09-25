/**
 * UI-only preview for local development. The build-time NODE_ENV guard keeps
 * this switch from bypassing authentication in production deployments.
 */
export const isLocalPreviewMode =
  process.env.NODE_ENV === "development" &&
  process.env.NEXT_PUBLIC_LOCAL_PREVIEW === "true";
