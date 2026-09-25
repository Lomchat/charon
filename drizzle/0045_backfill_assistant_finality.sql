-- One-time classification of pre-0044 assistant rows. Follow the same
-- chronological key as the chat API; row id alone can place repaired events
-- in the wrong turn. User/peer input opens a turn; final usage and terminal
-- errors close it. Existing final rows are also boundaries.
CREATE TEMP TABLE assistant_finality_backfill (
  id integer PRIMARY KEY,
  session_id text NOT NULL,
  finality integer NOT NULL,
  pending integer NOT NULL
);--> statement-breakpoint
INSERT INTO assistant_finality_backfill (id, session_id, finality, pending)
WITH timeline AS (
  SELECT
    m.id, m.session_id, m.role, m.assistant_final,
    coalesce(m.ts_ms, m.created_at * 1000) AS sort_ts,
    CASE WHEN m.role IN ('user', 'external', 'error')
      OR (m.role = 'event' AND (
        m.content LIKE '{"type":"turn_usage"%'
        OR m.content LIKE '{"type":"external_message"%'
      ))
      OR (m.role = 'assistant' AND m.assistant_final = 1)
      THEN 1 ELSE 0 END AS boundary
  FROM claude_session_messages m
  WHERE m.role IN ('assistant', 'user', 'external', 'error')
    OR (m.role = 'event' AND (
      m.content LIKE '{"type":"turn_usage"%'
      OR m.content LIKE '{"type":"external_message"%'
    ))
), segmented AS (
  SELECT *,
    coalesce(sum(boundary) OVER (
      PARTITION BY session_id ORDER BY sort_ts, id
      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    ), 0) AS segment,
    sum(boundary) OVER (PARTITION BY session_id) AS total_boundaries
  FROM timeline
), assistants AS (
  SELECT *, row_number() OVER (
    PARTITION BY session_id, segment ORDER BY sort_ts DESC, id DESC
  ) AS reverse_position
  FROM segmented WHERE role = 'assistant'
)
SELECT a.id, a.session_id,
  CASE WHEN a.reverse_position = 1 AND (
    a.segment < a.total_boundaries OR coalesce(s.status, 'sleeping') NOT IN ('thinking', 'starting')
  ) THEN 1 ELSE 0 END AS finality,
  CASE WHEN a.reverse_position = 1 AND a.segment = a.total_boundaries
    AND s.status IN ('thinking', 'starting') THEN 1 ELSE 0 END AS pending
FROM assistants a LEFT JOIN claude_sessions s ON s.id = a.session_id
WHERE a.assistant_final IS NULL;--> statement-breakpoint
UPDATE claude_session_messages
SET assistant_final = (SELECT finality FROM assistant_finality_backfill b WHERE b.id = claude_session_messages.id)
WHERE id IN (SELECT id FROM assistant_finality_backfill);--> statement-breakpoint
-- Keep the final text of a live, pre-migration turn addressable by the stop
-- handler. A newer assistant row may already own the pointer; never replace it.
UPDATE claude_sessions
SET pending_assistant_message_id = (
  SELECT b.id FROM assistant_finality_backfill b
  WHERE b.session_id = claude_sessions.id AND b.pending = 1
)
WHERE pending_assistant_message_id IS NULL
  AND EXISTS (
    SELECT 1 FROM assistant_finality_backfill b
    WHERE b.session_id = claude_sessions.id AND b.pending = 1
  );--> statement-breakpoint
DROP TABLE assistant_finality_backfill;
