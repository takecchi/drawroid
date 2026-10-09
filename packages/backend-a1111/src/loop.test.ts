// M6:156「M1〜M5 のスタブのテストが、A1111 のアダプタでも通る」。試験の本体は storage-fs の testing にあり、Forge のアダプタにも同じものを当てている。
// ここは A1111Backend を偽の A1111（雛形は実機の応答ではない。fixtures/README.md）に繋いで渡すだけ
import { describeLoopScenarios } from '@drawroid/storage-fs/testing';

import { A1111Backend } from './a1111-backend.js';
import { fakeTxt2img, startMockA1111, unusedUrl } from './test-support/mock-a1111.js';

describeLoopScenarios('A1111Backend', {
  start: async (options) => {
    const mock = await startMockA1111(options);
    return {
      backend: new A1111Backend({ baseUrl: mock.url }),
      requests: mock.requests,
      route: (key, handler) => mock.route(key, handler),
      close: () => mock.close(),
    };
  },
  unreachable: async () => new A1111Backend({ baseUrl: await unusedUrl() }),
  respondToGeneration: fakeTxt2img,
  controlnetModel: 'control_v11p_sd15_canny [d14c016b]',
});
