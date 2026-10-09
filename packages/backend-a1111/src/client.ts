import { SdapiClient, type CallOptions, type SdapiConnection } from '@drawroid/backend-sdapi';

export type { CallOptions };

export type A1111Connection = Omit<SdapiConnection, 'product'>;

/** A1111 の /sdapi/v1 の呼び出し。エラーの文面には「A1111」と出す */
export class A1111Client extends SdapiClient {
  constructor(connection: A1111Connection) {
    super({ ...connection, product: 'A1111' });
  }
}
