import { type RouteConfig, index, route } from '@react-router/dev/routes';

export default [
  index('routes/home.tsx'),
  route('memory', 'routes/memory.tsx'),
  route('memory/:id', 'routes/memory-item.tsx'),
] satisfies RouteConfig;
