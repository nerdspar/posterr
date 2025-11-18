// classes/mediaservers/jellyfin.js
// Minimal Jellyfin adapter for Posterr
//
// Implements:
//  - constructor(opts)
//  - async GetNowScreening(playThemes, genericThemes, hasArt, filterRemote, filterLocal, filterDevices, filterUsers, hideUser, excludeLibraries)
//  - async GetOnDemand(libraries, numberOnDemand, playThemes, genericThemes, hasArt, genres, recentlyAddedDays, contentRatings)
//
// Notes:
//  - opts: { jellyfinUrl, jellyfinApiKey, userId, libraries, hasArt }
//  - This adapter returns a lightweight "card" object compatible with Posterr's usage (title, mediaType, progressPercent, poster/backdrop, player info, resume position).
//  - Images are returned as direct Jellyfin image endpoints (authenticated via X-Emby-Token header). Use the image proxy route in index.js (recommended) to avoid 401s.

const axios = require('axios');

class JellyfinMS {
  constructor(opts = {}) {
    if (!opts.jellyfinUrl || !opts.jellyfinApiKey) {
      throw new Error('JellyfinMS requires jellyfinUrl and jellyfinApiKey');
    }
    this.base = opts.jellyfinUrl.replace(/\/$/, '');
    this.token = opts.jellyfinApiKey;
    this.userId = opts.userId || null;
    this.libraries = opts.libraries || null;
    this.hasArt = opts.hasArt || false;

    this.client = axios.create({
      baseURL: this.base,
      timeout: 8000,
      headers: {
        'X-Emby-Token': this.token,
        'Accept': 'application/json'
      }
    });
  }

  // helper to convert ticks -> ms (Jellyfin often uses ticks (10000 ticks = 1 ms))
  _ticksToMs(ticks) {
    if (!ticks && ticks !== 0) return null;
    // Some endpoints return PlaybackPositionTicks or PositionTicks as integer ticks
    // Guard for both numbers and strings
    const n = Number(ticks);
    if (isNaN(n)) return null;
    return Math.floor(n / 10000);
  }

  // Build image URL for item (Primary / Backdrop)
  _imageUrl(itemId, type = 'Primary', maxWidth) {
    // Use Posterr image proxy pattern: /jellyfin/image/:itemId?type=Primary&maxWidth=...
    // If you do NOT install the proxy, either ensure your Posterr UI can send headers, or change this to direct Jellyfin URL.
    const qs = maxWidth ? `?maxWidth=${maxWidth}` : '';
    return `/jellyfin/image/${encodeURIComponent(itemId)}?type=${encodeURIComponent(type)}${qs}`;
  }

  // Normalize a Jellyfin session item into a Posterr now-playing "card-like" object
  _mapSessionToCard(session) {
    try {
      const item = session.NowPlayingItem || {};
      const ps = session.PlayState || {};
      const user = session.User || {};
      const posMs = this._ticksToMs(ps.PositionTicks) || (ps.Position != null ? ps.Position : null);
      const runtime = item.RunTimeTicks ? this._ticksToMs(item.RunTimeTicks) : (item.RunTime || null);

      // Map common fields Posterr expects
      const card = {
        // basic
        title: item.Name || '',
        mediaType: (item.Type || '').toLowerCase(), // 'movie' or 'episode' or 'audio'
        // episode details (if episode)
        seriesTitle: item.SeriesName || null,
        episodeName: item.Name || null,
        season: item.ParentIndexNumber || null,
        episode: item.IndexNumber || null,
        // playback/progress
        runtimeMs: runtime,
        progressMs: posMs,
        progressPercent: (runtime && posMs) ? Math.round((posMs / runtime) * 100) : 0,
        // player
        playerName: session.DeviceName || (session.Client && session.Client.Name) || null,
        playerIP: session.RemoteEndPoint || null,
        playerDevice: (session.Device && session.Device) || (session.Client && session.Client.Name) || null,
        // IDs
        itemId: item.Id || null,
        sessionId: session.Id || null,
        userId: session.UserId || (user && user.Id) || null,
        // images
        posterUrl: item.Id ? this._imageUrl(item.Id, 'Primary') : null,
        backdropUrl: item.Id ? this._imageUrl(item.Id, 'Backdrop') : null,
        // raw
        __raw: session
      };

      // Provide a "progress" field used in some Posterr code paths
      card.progress = card.progressPercent;

      // theme placeholder (Posterr sets theme from movie/episode; leave blank)
      card.theme = item.Type === 'Movie' ? 'movie' : (item.Type === 'Episode' ? 'episode' : '');

      return card;
    } catch (e) {
      return null;
    }
  }

  // --- Public methods expected by index.js ---

  /**
   * GetNowScreening - returns array of now-playing cards
   * Mirrors call signature used by Posterr:
   *  GetNowScreening(playThemes, genericThemes, hasArt, filterRemote, filterLocal, filterDevices, filterUsers, hideUser, excludeLibraries)
   */
  async GetNowScreening(playThemes, genericThemes, hasArt, filterRemote, filterLocal, filterDevices, filterUsers, hideUser, excludeLibraries) {
    try {
      const resp = await this.client.get('/Sessions');
      const sessions = resp.data || [];

      // Map and filter sessions (respect some basic filters if provided)
      let cards = sessions
        .map(s => this._mapSessionToCard(s))
        .filter(c => c !== null);

      // Optional filtering: exclude libraries by provider Ids not trivial to map here.
      if (excludeLibraries && Array.isArray(excludeLibraries) && excludeLibraries.length > 0) {
        // We don't have libraryId on session item easily; skip sophisticated exclusion for now.
      }

      // Optionally hide user display
      if (hideUser === true || hideUser === 'true') {
        cards = cards.map(c => { delete c.userId; return c; });
      }

      return cards;
    } catch (err) {
      // On error, return empty array (Posterr handles)
      return [];
    }
  }

  /**
   * GetOnDemand - returns array of on-demand/resume items for display
   * Mirrors call signature:
   *  GetOnDemand(libraries, numberOnDemand, playThemes, genericThemes, hasArt, genres, recentlyAddedDays, contentRatings)
   *
   * Strategy:
   *  - If userId available: fetch /Users/{userId}/Items/Resume (best analogue to OnDeck)
   *  - Fallback: use /Users/{userId}/Items/Latest or /Items?Filters=IsFolder%3Afalse&IncludeItemTypes=Movie%2CEpisode (simple approximation)
   */
  async GetOnDemand(libraries, numberOnDemand = 20, playThemes, genericThemes, hasArt, genres, recentlyAddedDays, contentRatings) {
    const limit = Math.min(200, Number(numberOnDemand) || 30);

    try {
      let items = [];

      if (this.userId) {
        // Primary approach: resume items (user-specific)
        const resp = await this.client.get(`/Users/${encodeURIComponent(this.userId)}/Items/Resume`, { params: { Limit: limit } });
        items = (resp.data && resp.data.Items) ? resp.data.Items : (resp.data || []);
      }

      // If resume returned nothing, try latest items (recently added)
      if ((!items || items.length === 0) && (this.userId || true)) {
        // Use /Items with filters (recently added fallback)
        const params = {
          Limit: limit,
          // optionally filter by library id(s) if provided (Jellyfin uses ParentId / LibraryId)
        };
        // If recentlyAddedDays specified, we can use a MinDateCreated param (Jellyfin does not have exactly this in all versions).
        const resp2 = await this.client.get('/Items/Latest', { params });
        items = (resp2.data && resp2.data.Items) ? resp2.data.Items : (resp2.data || []);
      }

      // Map items to Posterr card-like objects
      const cards = (items || []).map(it => {
        const runtime = it.RunTimeTicks ? this._ticksToMs(it.RunTimeTicks) : (it.RunTime || null);
        const resumeMs = (it.UserData && it.UserData.PlaybackPositionTicks) ? this._ticksToMs(it.UserData.PlaybackPositionTicks) :
                         (it.UserData && it.UserData.PlayState && it.UserData.PlayState.Position ? it.UserData.PlayState.Position : null);

        return {
          title: it.Name || '',
          mediaType: (it.Type || '').toLowerCase(),
          seriesTitle: it.SeriesName || null,
          episodeName: it.Name || null,
          season: it.ParentIndexNumber || null,
          episode: it.IndexNumber || null,
          itemId: it.Id || null,
          posterUrl: it.Id ? this._imageUrl(it.Id, 'Primary') : null,
          backdropUrl: it.Id ? this._imageUrl(it.Id, 'Backdrop') : null,
          runtimeMs: runtime,
          resumePositionMs: resumeMs,
          resumePercent: (runtime && resumeMs) ? Math.round((resumeMs / runtime) * 100) : 0,
          // other UI fields Posterr may use:
          theme: it.Type === 'Movie' ? 'movie' : (it.Type === 'Episode' ? 'episode' : ''),
          userId: (it.UserData && it.UserData.LastPlayedUserId) ? it.UserData.LastPlayedUserId : null,
          // raw
          __raw: it
        };
      });

      // Limit to requested numberOnDemand
      return cards.slice(0, limit);
    } catch (err) {
      return [];
    }
  }
}

module.exports = JellyfinMS;
