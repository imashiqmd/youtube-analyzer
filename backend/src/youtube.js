const YOUTUBE_BASE = "https://www.googleapis.com/youtube/v3";

export class QuotaTracker {
  constructor() {
    this.units = 0;
    this.calls = [];
  }

  record(endpoint, units = 1) {
    this.units += units;
    this.calls.push({ endpoint, units });
  }
}

async function youtubeRequest(endpoint, params, apiKey, tracker) {
  const url = new URL(`${YOUTUBE_BASE}/${endpoint}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  });
  url.searchParams.set("key", apiKey);

  const res = await fetch(url);
  const data = await res.json();
  tracker.record(endpoint, 1);

  if (!res.ok) {
    const message = data?.error?.message || `YouTube API request failed (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    err.youtubeError = data?.error;
    throw err;
  }

  return data;
}

export async function resolveChannel(apiKey, attempts, tracker) {
  for (const attempt of attempts) {
    const params = { part: "snippet,statistics,contentDetails" };
    params[attempt.param] = attempt.value;
    const data = await youtubeRequest("channels", params, apiKey, tracker);
    if (data.items?.length) {
      const item = data.items[0];
      const thumbs = item.snippet?.thumbnails || {};
      return {
        id: item.id,
        title: item.snippet?.title,
        thumbnail: thumbs.default?.url || thumbs.medium?.url || "",
        subscriberCount:
          item.statistics && !item.statistics.hiddenSubscriberCount
            ? Number(item.statistics.subscriberCount)
            : null,
        videoCount:
          item.statistics?.videoCount !== undefined
            ? Number(item.statistics.videoCount)
            : null,
        publishedAt: item.snippet?.publishedAt || null,
        uploadsPlaylistId: item.contentDetails?.relatedPlaylists?.uploads,
      };
    }
  }

  throw new Error(
    "Couldn't find that channel. Use the exact @handle or full channel URL (search.list is not used)."
  );
}

export async function fetchAllPlaylistVideoIds(apiKey, playlistId, tracker) {
  const videoIds = [];
  let pageToken;

  do {
    const params = {
      part: "contentDetails",
      playlistId,
      maxResults: 50,
    };
    if (pageToken) params.pageToken = pageToken;

    const data = await youtubeRequest("playlistItems", params, apiKey, tracker);
    for (const item of data.items || []) {
      const videoId = item.contentDetails?.videoId;
      if (videoId) videoIds.push(videoId);
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  return videoIds;
}

function compactRawVideo(video) {
  const snippet = video.snippet || {};
  return {
    id: video.id,
    snippet: {
      title: snippet.title,
      publishedAt: snippet.publishedAt,
      description: snippet.description || "",
      tags: Array.isArray(snippet.tags) ? snippet.tags : [],
    },
    contentDetails: video.contentDetails,
    statistics: video.statistics,
    liveStreamingDetails: video.liveStreamingDetails || undefined,
  };
}

export async function fetchVideosDetails(apiKey, videoIds, tracker) {
  const results = [];
  for (let i = 0; i < videoIds.length; i += 50) {
    const chunk = videoIds.slice(i, i + 50);
    const data = await youtubeRequest(
      "videos",
      {
        part: "snippet,contentDetails,liveStreamingDetails,statistics",
        id: chunk.join(","),
      },
      apiKey,
      tracker
    );
    results.push(...(data.items || []));
  }
  return results.map(compactRawVideo);
}

export async function fetchChannelFromYouTube(apiKey, attempts, tracker) {
  const channel = await resolveChannel(apiKey, attempts, tracker);
  if (!channel.uploadsPlaylistId) {
    throw new Error("Channel has no uploads playlist.");
  }

  const videoIds = await fetchAllPlaylistVideoIds(apiKey, channel.uploadsPlaylistId, tracker);
  if (!videoIds.length) {
    throw new Error("This channel has no public uploads.");
  }

  const rawVideos = await fetchVideosDetails(apiKey, videoIds, tracker);
  const videoMap = new Map(rawVideos.map((v) => [v.id, v]));
  const orderedVideos = videoIds.map((id) => videoMap.get(id)).filter(Boolean);

  return { channel, videoIds, rawVideos: orderedVideos };
}
