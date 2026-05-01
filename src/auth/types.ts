// ---------------------------------------------------------------------------
// Auth types
// ---------------------------------------------------------------------------

export type Project = {
  id: string;
  name: string;
  apiKeyHash: string;
  createdAt: string;
};

export type ApiKeyInfo = {
  projectId: string;
  prefix: string;
};
