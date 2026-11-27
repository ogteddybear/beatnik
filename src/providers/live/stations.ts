export interface LiveStation {
  name: string;
  url: string;
  genre: string;
  artworkUrl: string;
  metadataUrl?: string;
}

export const LIVE_SERVICE = "We aRe oNe";

export const LIVE_STATIONS = {
  technobase: {
    name: "TechnoBase.FM",
    url: "http://listen.technobase.fm/tunein-mp3",
    genre: "HandsUp / Dance / Happy Hardcore",
    artworkUrl: "https://www.technobase.fm/media/icons/tb/apple-touch-icon.png",
  },
  housetime: {
    name: "HouseTime.FM",
    url: "http://listen.housetime.fm/tunein-mp3",
    genre: "EDM / Bigroom / House",
    artworkUrl: "https://www.housetime.fm/media/icons/ht/apple-touch-icon.png",
  },
  hardbase: {
    name: "HardBase.FM",
    url: "http://listen.hardbase.fm/tunein-mp3",
    genre: "Euphoric / Raw / Hardstyle",
    artworkUrl: "https://www.hardbase.fm/media/icons/hb/apple-touch-icon.png",
  },
  trancebase: {
    name: "TranceBase.FM",
    url: "http://listen.trancebase.fm/tunein-mp3",
    genre: "Uplifting / Progressive Trance",
    artworkUrl: "https://www.trancebase.fm/media/icons/trb/apple-touch-icon.png",
  },
} as const satisfies Record<string, LiveStation>;

export function findLiveStation(url: string): LiveStation | undefined {
  return Object.values(LIVE_STATIONS).find((station) => station.url === url);
}
