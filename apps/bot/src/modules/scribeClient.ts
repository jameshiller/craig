/**
 * Minimal client for scribe's internal registry API.
 *
 * Runs inside Craig's bot container; the API is only reachable on the shared docker
 * network and needs the shared token. Config comes from the environment so a Craig
 * upgrade never has to know about scribe:
 *
 *   SCRIBE_API_URL   default http://scribe-api:8090
 *   SCRIBE_API_TOKEN required; the bot refuses to serve /campaign without it
 */

const BASE = (process.env.SCRIBE_API_URL || 'http://scribe-api:8090').replace(/\/+$/, '');
const TOKEN = process.env.SCRIBE_API_TOKEN || '';

export class ScribeApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'ScribeApiError';
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

async function request<T>(method: Method, path: string, body?: unknown, query?: Record<string, string>): Promise<T> {
  if (!TOKEN) throw new ScribeApiError(500, 'SCRIBE_API_TOKEN is not set for the bot container');

  let url = `${BASE}${path}`;
  if (query) {
    const qs = new URLSearchParams(query).toString();
    if (qs) url += `?${qs}`;
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-scribe-token': TOKEN
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000)
    });
  } catch (err) {
    throw new ScribeApiError(503, `scribe API unreachable at ${BASE}: ${(err as Error).message}`);
  }

  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!res.ok) {
    const detail = (data && (data.detail || data.error)) || text || res.statusText;
    throw new ScribeApiError(res.status, typeof detail === 'string' ? detail : JSON.stringify(detail));
  }
  return data as T;
}

export interface PlayerRecord {
  player: string;
  character: string | null;
  role: 'player' | 'gm';
  notes: string;
  added_at?: string;
}

export interface CampaignRecord {
  name: string;
  slug: string;
  system: string;
  setting: string;
  voice_channel_id: string;
  text_channel_id: string;
  players: Record<string, PlayerRecord>;
  gm_ids?: string[];
  glossary: string[];
  created_at: string;
  created_by: string;
  active?: boolean;
  root?: string;
  bible?: { session_count: number; last_session: string | null; brief: string };
}

export interface CampaignRow {
  slug: string;
  name: string;
  system: string;
  setting: string;
  voice_channel_id: string;
  text_channel_id: string;
  player_count: number;
  gm_ids: string[];
  sessions: number;
  last_session: string | null;
  active: boolean;
}

export const scribe = {
  health: () => request<{ ok: boolean; campaigns: number; default: string }>('GET', '/health'),

  listCampaigns: () =>
    request<{ default: string; campaigns: CampaignRow[] }>('GET', '/campaigns'),

  getCampaign: (slug: string) => request<CampaignRecord>('GET', `/campaigns/${encodeURIComponent(slug)}`),

  createCampaign: (body: { name: string; system?: string; setting?: string; context?: string; actor: string }) =>
    request<CampaignRecord>('POST', '/campaigns', body),

  renameCampaign: (slug: string, body: { name?: string; system?: string; setting?: string; actor: string }) =>
    request<CampaignRecord>('PATCH', `/campaigns/${encodeURIComponent(slug)}`, body),

  deleteCampaign: (slug: string, actor: string) =>
    request<{ ok: boolean; trash: string | null }>('DELETE', `/campaigns/${encodeURIComponent(slug)}`, undefined, { actor }),

  link: (slug: string, body: { voice?: string; text?: string; actor: string }) =>
    request<{ slug: string; voice: string; text: string }>('POST', `/campaigns/${encodeURIComponent(slug)}/link`, body),

  setPlayer: (
    slug: string,
    userId: string,
    body: { player?: string; character?: string | null; role?: 'player' | 'gm'; notes?: string; actor: string }
  ) => request<PlayerRecord & { user_id: string }>('PUT', `/campaigns/${encodeURIComponent(slug)}/players/${userId}`, body),

  removePlayer: (slug: string, userId: string, actor: string) =>
    request<{ ok: boolean; user_id: string }>(
      'DELETE',
      `/campaigns/${encodeURIComponent(slug)}/players/${userId}`,
      undefined,
      { actor }
    ),

  addGlossary: (slug: string, term: string, actor: string) =>
    request<{ glossary: string[] }>('POST', `/campaigns/${encodeURIComponent(slug)}/glossary`, { term, actor }),

  removeGlossary: (slug: string, term: string, actor: string) =>
    request<{ glossary: string[] }>('DELETE', `/campaigns/${encodeURIComponent(slug)}/glossary/${encodeURIComponent(term)}`, undefined, { actor })
};

/** GM on that campaign, or a Discord admin. */
export function canManageCampaign(campaign: CampaignRecord, userId: string, isAdmin: boolean): boolean {
  return isAdmin || (campaign.gm_ids ?? []).includes(userId);
}
