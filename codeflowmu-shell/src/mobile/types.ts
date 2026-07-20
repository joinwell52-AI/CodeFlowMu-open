import type { Response } from "express";

export type MobileOperatorRole = "mobile_operator";

export interface MobileDeviceRecord {
  device_id: string;
  device_name: string;
  bound_at: string;
  last_seen_at: string;
  enabled: boolean;
  session_token_hash?: string;
  session_expires_at?: string;
}

export interface MobileDevicesFile {
  devices: MobileDeviceRecord[];
}

export interface MobileAuthContext {
  device_id: string;
  role: MobileOperatorRole;
}

export interface MobilePanelContext {
  getProjectRoot: () => string;
  getDataDir: () => string;
  panelPort?: number;
  getAdminTasksDir: () => string | undefined;
  getReviewsDir: () => string | undefined;
  getIssuesDir: () => string | undefined;
  getFcopReportsDir: () => string | undefined;
  listChatMessages: (opts: { agentId?: string; limit?: number }) => unknown[];
  sendChat: (body: {
    message?: string;
    agentId?: string;
    intent?: string;
    taskId?: string;
    threadKey?: string;
    source?: string;
    client?: string;
    attachments?: Array<{
      type?: string;
      url?: string;
      local_path?: string;
      absolute_path?: string;
      mime?: string;
      original_name?: string;
      size?: number;
      sha256?: string;
    }>;
  }) => Promise<{ ok: boolean; status?: number; error?: string; [key: string]: unknown }>;
  listAlerts: (opts?: { limit?: number }) => unknown;
  subscribeMobileEvents: (res: Response, onClose: () => void) => void;
  createAdminPmTask?: (
    body: unknown,
  ) => Promise<{ ok: boolean; status?: number; error?: string; [key: string]: unknown }>;
  gatewayOnline?: () => boolean;
  allocateTaskSeq?: (date: string) => string;
  getUiLang?: () => string;
}

export interface MobileRoutesBundle {
  router: import("express").Router;
  registerPendingBind: (bindId: string, token: string, ttlMs: number) => void;
}
