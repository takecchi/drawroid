import { type RouteConfig, index, route } from '@react-router/dev/routes';

export default [
  index('routes/conversations.tsx'),
  route('conversations/:conversationId', 'routes/conversation.tsx'),
  route('generate', 'routes/generate.tsx'),
  route('memory', 'routes/memory.tsx'),
  route('memory/:id', 'routes/memory-item.tsx'),
  route('permissions', 'routes/permissions.tsx'),
  route('candidates', 'routes/candidates.tsx'),
  route('jobs', 'routes/jobs.tsx'),
  route('jobs/new', 'routes/new-job.tsx'),
  route('jobs/:jobId', 'routes/job.tsx'),
] satisfies RouteConfig;
