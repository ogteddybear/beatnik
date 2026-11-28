export const TIDAL_LINK_MESSAGE =
  "Link or reconnect your Tidal account: https://dis.sashimi.zip/auth/tidal";

export class TidalNotLinkedError extends Error {
  constructor() {
    super(TIDAL_LINK_MESSAGE);
    this.name = "TidalNotLinkedError";
  }
}

export class TidalApiError extends Error {
  constructor(public readonly status: number) {
    super("Tidal is temporarily unavailable or access was denied.");
    this.name = "TidalApiError";
  }
}
