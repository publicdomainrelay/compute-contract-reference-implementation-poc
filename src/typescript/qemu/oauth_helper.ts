/**
 * oauth_helper.ts — OAuth token persistence (mirrors oauth_helper.py)
 */

import { getOauthToken, saveOauthToken } from "./database.ts";

export function storeOauthToken(actx: string, token: string): void {
  saveOauthToken(actx, token);
}

export function retrieveOauthToken(actx: string): string | null {
  try {
    return getOauthToken(actx);
  } catch {
    return null;
  }
}
