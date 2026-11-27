declare module "icecast-metadata-js" {
  export class IcecastMetadataReader {
    constructor(options: {
      icyMetaInt: number;
      icyDetectionTimeout: number;
      metadataTypes: ("icy" | "ogg")[];
    });
    iterator(chunk: Uint8Array): IterableIterator<{
      stream?: Uint8Array;
      metadata?: Record<string, string>;
    }>;
  }
}
