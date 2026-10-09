import { Hono } from 'hono';

import type { ApiDeps } from './deps.js';
import { handleUncaught } from './errors.js';
import { autoJobsRoutes } from './routes/auto-jobs.js';
import { backendRoutes } from './routes/backend.js';
import { backendSettingsRoutes } from './routes/backend-settings.js';
import { budgetSettingsRoutes } from './routes/budget-settings.js';
import { candidateNotesRoutes } from './routes/candidate-notes.js';
import { conversationsRoutes } from './routes/conversations.js';
import { generationProgressSettingsRoutes } from './routes/generation-progress-settings.js';
import { progressPreviewRoutes } from './routes/progress-preview.js';
import { filesRoutes } from './routes/files.js';
import { healthRoutes } from './routes/health.js';
import { iterationsRoutes } from './routes/iterations.js';
import { interventionsRoutes } from './routes/interventions.js';
import { jobsRoutes } from './routes/jobs.js';
import { llmSettingsRoutes } from './routes/llm-settings.js';
import { llmCallsRoutes, unattachedLlmCallsRoutes } from './routes/llm-calls.js';
import { manualJobsRoutes } from './routes/manual-jobs.js';
import { memoryRoutes } from './routes/memory.js';
import { permissionSettingsRoutes } from './routes/permission-settings.js';
import { selectionsRoutes } from './routes/selections.js';
import { adoptRoutes } from './routes/adopt.js';
import { stopConditionParseRoutes } from './routes/stop-condition-parse.js';
import { stopConditionsRoutes } from './routes/stop-conditions.js';

export {
  BackendBusyError,
  backendKindSchema,
  backendSettingsViewSchema,
  updateBackendSettingsSchema,
  type BackendKind,
  type BackendSettingsPort,
  type BackendSettingsView,
  type UpdateBackendSettings,
} from './backend-settings.js';
export { LlmNotConfiguredError, type StopConditionParser } from './stop-condition-parse.js';
export { imageUrls } from './iterations.js';
export type { ReferenceUploadInput } from './references.js';
export type {
  ApiDeps,
  AutoJobQueue,
  BudgetSettingsPort,
  CandidateNotesStore,
  ConversationsPort,
  GenerationProgressSettingsPort,
  LlmSettingsStore,
  PermissionSettingsStore,
} from './deps.js';
export type { ApiErrorBody } from './errors.js';

// 機能ごとのルートは routes/ に1ファイルずつ置き、ここには1行ずつ足す
export function createApi(deps: ApiDeps) {
  return new Hono()
    .route('/health', healthRoutes)
    .route('/backend', backendRoutes(deps))
    .route('/settings/backend', backendSettingsRoutes(deps))
    .route('/backend', candidateNotesRoutes(deps))
    .route('/jobs/manual', manualJobsRoutes(deps))
    .route('/jobs/auto', autoJobsRoutes(deps))
    .route('/jobs/:jobId/iterations', iterationsRoutes(deps))
    .route('/jobs/:jobId/llm-calls', llmCallsRoutes(deps))
    .route('/llm-calls', unattachedLlmCallsRoutes(deps))
    .route('/jobs/auto', interventionsRoutes(deps))
    .route('/jobs/auto', stopConditionsRoutes(deps))
    .route('/jobs', jobsRoutes(deps))
    .route('/memory', memoryRoutes(deps))
    .route('/jobs', selectionsRoutes(deps))
    .route('/jobs', adoptRoutes(deps))
    .route('/files', filesRoutes(deps))
    .route('/settings/llm', llmSettingsRoutes(deps))
    .route('/stop-conditions', stopConditionParseRoutes(deps))
    .route('/settings/permissions', permissionSettingsRoutes(deps))
    .route('/settings/budgets', budgetSettingsRoutes(deps))
    .route('/settings/generation-progress', generationProgressSettingsRoutes(deps))
    .route('/jobs', progressPreviewRoutes(deps))
    .route('/conversations', conversationsRoutes(deps))
    .onError(handleUncaught);
}

export type AppType = ReturnType<typeof createApi>;
