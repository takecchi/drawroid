// M6:156 の通しの試験（storage-fs の testing）に、ForgeBackend を偽の Forge に繋いで渡す。A1111 のアダプタにも同じものを当てている
import { describeLoopScenarios } from '@drawroid/storage-fs/testing';

import { ForgeBackend } from './forge-backend.js';
import { fakeTxt2img, startMockForge, unusedUrl } from './test-support/mock-forge.js';

describeLoopScenarios('ForgeBackend', {
  // 偽の Forge は ControlNet が入った構成しか持たないので、controlnet の指定は見ない
  start: async ({ generatedImage }) => {
    const mock = await startMockForge(generatedImage === undefined ? {} : { generatedImage });
    return {
      backend: new ForgeBackend({ baseUrl: mock.url }),
      requests: mock.requests,
      route: (key, handler) => mock.route(key, handler),
      close: () => mock.close(),
    };
  },
  unreachable: async () => new ForgeBackend({ baseUrl: await unusedUrl() }),
  respondToGeneration: fakeTxt2img,
  controlnetModel: 'diffusers_xl_canny_full [2b69fca4]',
});
