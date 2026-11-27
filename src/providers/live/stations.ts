export interface LiveStation {
  name: string;
  url: string;
  genre: string;
  metadataUrl?: string;
}

export const LIVE_STATIONS = {
  technobase: {
    name: "TechnoBase.FM",
    url: "http://listen.technobase.fm/tunein-mp3",
    genre: "HandsUp / Dance / Happy Hardcore",
  },
  housetime: {
    name: "HouseTime.FM",
    url: "http://listen.housetime.fm/tunein-mp3",
    genre: "EDM / Bigroom / House",
  },
  hardbase: {
    name: "HardBase.FM",
    url: "http://listen.hardbase.fm/tunein-mp3",
    genre: "Euphoric / Raw / Hardstyle",
  },
  trancebase: {
    name: "TranceBase.FM",
    url: "http://listen.trancebase.fm/tunein-mp3",
    genre: "Uplifting / Progressive Trance",
  },
  coretime: {
    name: "CoreTime.FM",
    url: "http://listen.coretime.fm/tunein-mp3",
    genre: "Hardcore / Speedcore",
  },
} as const satisfies Record<string, LiveStation>;

export function findLiveStation(url: string): LiveStation | undefined {
  return Object.values(LIVE_STATIONS).find((station) => station.url === url);
}
