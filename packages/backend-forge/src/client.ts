import { SdapiClient, type CallOptions, type SdapiConnection } from '@drawroid/backend-sdapi';

export type { CallOptions };

export type ForgeConnection = Omit<SdapiConnection, 'product'>;

/** Forge の /sdapi/v1 の呼び出し。エラーの文面には「Forge」と出す */
export class ForgeClient extends SdapiClient {
  constructor(connection: ForgeConnection) {
    super({ ...connection, product: 'Forge' });
  }
}
