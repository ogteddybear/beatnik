export function proxyImageUrl(originalUrl: string): string {
  if (!originalUrl) return originalUrl;
  if (/^(?:https:\/\/dis\.sashimi\.zip)?\/api\/image-proxy\//.test(originalUrl)) return originalUrl;
  const encoded = Buffer.from(originalUrl).toString("base64url");
  return `https://dis.sashimi.zip/api/image-proxy/${encoded}`;
}
