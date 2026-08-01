export interface ConversationRow {
  id: string;
  title: string | null;
  first_user_prompt: string | null;
  mode: string;
  context_url: string | null;
  context_kind: string | null;
  context_ref: string | null;
  last_interaction_at: string;
  created_at: string;
  archived_at: string | null;
  last_status: string | null;
  llm_provider: string | null;
  llm_driver: string | null;
  message_count: number;
  tool_calls_count: number;
  rounds_count: number;
  duration_seconds: number;
  last_message_preview: string | null;
  token_total: number;
  context_dashboard_name?: string | null;
  last_read_at: string | null;
  is_unread: boolean;
}
