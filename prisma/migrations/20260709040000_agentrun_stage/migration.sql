-- AgentRun 진행 가시성: 현재 단계(stage)와 실제 실행 시작 시각(startedAt) 추가.
-- stage: running 중 fetch|curate|embed|lint 로 갱신, 종료(done/error) 시 null.
-- startedAt: running 전이 시각 — createdAt(큐 진입)과 분리해 대기 vs 실행을 구분.
ALTER TABLE "AgentRun" ADD COLUMN "stage" TEXT;
ALTER TABLE "AgentRun" ADD COLUMN "startedAt" TIMESTAMP(3);
