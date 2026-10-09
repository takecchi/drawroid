import type {
  GenerationRequestInput,
  SelectionVerdict,
  StopConditions,
  StopConditionsChange,
} from '@drawroid/core';
import { mutate } from 'swr';

import { unwrap, unwrapEmpty } from './api-error.js';
import { client } from './client.js';
import { keys } from './keys.js';
import type {
  AddInstructionResponse,
  AddMaskResponse,
  AddReferenceResponse,
  BackendSettingsResponse,
  BudgetOverridesInput,
  BudgetSettingsResponse,
  CandidateNotesInput,
  CandidateNotesResponse,
  ConversationEventsResponse,
  ConversationResponse,
  ConversationUploadResponse,
  PostedMessageResponse,
  ChangeStopConditionsResponse,
  CreateAutoJobResponse,
  LlmSettingsInput,
  LlmSettingsResponse,
  PermissionOverridesInput,
  PermissionSettingsResponse,
  ReferenceUpload,
  SavedMemoryItem,
  SaveMemoryInput,
  SetSelectionResponse,
  AdoptImageResponse,
  DoctorResponse,
  GenerationProgressSettingsResponse,
  StopConditionsDraftResponse,
} from './types.js';

/** 検証に落ちたときは ApiError（kind: 'invalid_request'）を投げる */
export async function startManualJob(params: GenerationRequestInput): Promise<{ jobId: string }> {
  const started = await unwrap<{ jobId: string }>(() => client.jobs.manual.$post({ json: params }));
  await mutate(keys.jobs);
  return started;
}

/**
 * バックエンドの状態を、いま開いている画面のぶんだけ読み直す。描く途中でバックエンドが落ちたと分かったときに呼ぶ。
 * 読めなければ、useBackendStatus の「繋がらない間の読み直し」が続く
 */
// 繋がっている間はポーリングしない（useBackendStatus）ので、落ちたと分かった時点で読み直させるため
export async function recheckBackendStatus(): Promise<void> {
  await mutate(keys.backend);
}

/** URL が不正なときは ApiError（kind: 'invalid_request'）を投げる */
export async function saveBackendSettings(input: {
  url: string;
}): Promise<BackendSettingsResponse> {
  const saved = await unwrap<BackendSettingsResponse>(() =>
    client.settings.backend.$put({ json: input }),
  );
  // 状態と候補は、繋ぎ直した先のものへ取り直す: 古いバックエンドの応答が残ると、直したのに直っていないように見えるため
  await mutate((key) => typeof key === 'string' && key.startsWith(keys.backend));
  await mutate(keys.backendSettings, saved, { revalidate: false });
  return saved;
}

/** 開いたあとにファイルが変わっていれば ApiError（kind: 'conflict'）、検証に落ちれば 'invalid_request' を投げる */
export async function saveMemoryItem(id: string, input: SaveMemoryInput): Promise<SavedMemoryItem> {
  const saved = await unwrap<SavedMemoryItem>(() =>
    client.memory[':id'].$put({ param: { id }, json: input }),
  );
  await Promise.all([mutate(keys.memory), mutate(keys.memoryItem(id))]);
  return saved;
}

export async function deleteMemoryItem(id: string): Promise<void> {
  await unwrapEmpty(() => client.memory[':id'].$delete({ param: { id } }));
  // 消した項目のキーは取り直さない: 取り直すと 404 が画面のエラーとして一瞬見えるため、キャッシュごと捨てる
  await Promise.all([
    mutate(keys.memory),
    mutate(keys.memoryItem(id), undefined, { revalidate: false }),
  ]);
}

/**
 * LLM の設定を保存する。形が違うとき・組み立てられないとき（provider が無い、API キーの環境変数が入っていない、など）は
 * ApiError（kind: 'invalid_request'）を投げ、message に理由が入る
 */
export async function saveLlmSettings(config: LlmSettingsInput): Promise<LlmSettingsResponse> {
  const saved = await unwrap<LlmSettingsResponse>(() => client.settings.llm.$put({ json: config }));
  // 保存の応答は読む口と同じ形なので、取り直さずにそのまま置く
  await mutate(keys.llmSettings, saved, { revalidate: false });
  return saved;
}

/**
 * 全体の既定の許可を、書いた欄ごと置き換える。書いた許可は、走行中のジョブにも次の回の境目から効く。
 * 形が違うとき（必須の欄に「使わない」など）は ApiError（kind: 'invalid_request'）を投げる
 */
export async function savePermissionSettings(
  overrides: PermissionOverridesInput,
): Promise<PermissionSettingsResponse> {
  const saved = await unwrap<PermissionSettingsResponse>(() =>
    client.settings.permissions.$put({ json: overrides }),
  );
  // 保存の応答は読む口と同じ形なので、取り直さずにそのまま置く
  await mutate(keys.permissionSettings, saved, { revalidate: false });
  return saved;
}

/**
 * 予算を、書いた欄ごと置き換える。書いた予算は、そのあとに投入するジョブから効く（走っているジョブには効かない）。
 * 範囲外の値や知らない鍵は ApiError（kind: 'invalid_request'）を投げる
 */
export async function saveBudgetSettings(
  overrides: BudgetOverridesInput,
): Promise<BudgetSettingsResponse> {
  const saved = await unwrap<BudgetSettingsResponse>(() =>
    client.settings.budgets.$put({ json: overrides }),
  );
  // 保存の応答は読む口と同じ形なので、取り直さずにそのまま置く
  await mutate(keys.budgetSettings, saved, { revalidate: false });
  return saved;
}

/**
 * 候補の説明を、全部まとめて置き換える。書いた説明は、次のジョブから考える役に渡る。
 * 長すぎる説明や多すぎる件数は ApiError（kind: 'invalid_request'）を投げる
 */
export async function saveCandidateNotes(
  notes: CandidateNotesInput,
): Promise<CandidateNotesResponse> {
  const saved = await unwrap<CandidateNotesResponse>(() =>
    client.backend['candidate-notes'].$put({ json: notes }),
  );
  // 保存の応答は読む口と同じ形なので、取り直さずにそのまま置く
  await mutate(keys.candidateNotes, saved, { revalidate: false });
  return saved;
}

/** 会話を作る。一覧を取り直す */
export async function createConversation(): Promise<ConversationResponse['conversation']> {
  const created = await unwrap<ConversationResponse>(() => client.conversations.$post());
  await mutate(keys.conversations);
  return created.conversation;
}

/** 会話のタイトルを直す */
export async function renameConversation(conversationId: string, title: string): Promise<void> {
  await unwrap<unknown>(() =>
    client.conversations[':conversationId'].$patch({ param: { conversationId }, json: { title } }),
  );
  await mutate(keys.conversations);
}

/**
 * 確定したイベントを after より後から1ページ読む（会話の画面が、開くときに読み通すため）。
 * limit を省けば API の既定の件数
 */
export function loadConversationEvents(
  conversationId: string,
  after: number,
  limit?: number,
): Promise<ConversationEventsResponse> {
  return unwrap<ConversationEventsResponse>(() =>
    client.conversations[':conversationId'].events.$get({
      param: { conversationId },
      query: { after: String(after), ...(limit === undefined ? {} : { limit: String(limit) }) },
    }),
  );
}

/** EventSource で開く購読の URL。つなぎ直しと Last-Event-ID はブラウザに任せる */
export function conversationStreamUrl(conversationId: string, after: number): string {
  return `${keys.conversations}/${conversationId}/stream?after=${after}`;
}

/**
 * 発言する。202 と確定した seq が返り、続きは購読（SSE）で届く。同じ clientMessageId の再送は二重に受けられない。
 * attachments は、先に uploadConversationImage で会話へ送り込んだ画像の ID
 */
export async function postConversationMessage(
  conversationId: string,
  text: string,
  clientMessageId: string,
  attachments: readonly { uploadId: string }[] = [],
): Promise<PostedMessageResponse> {
  const posted = await unwrap<PostedMessageResponse>(() =>
    client.conversations[':conversationId'].messages.$post({
      param: { conversationId },
      json: {
        text,
        clientMessageId,
        ...(attachments.length > 0 && { attachments: [...attachments] }),
      },
    }),
  );
  await mutate(keys.conversations);
  return posted;
}

/**
 * 会話で添える画像を1枚送り込み、その ID を返す。発言の attachments に載せると、話す役が描き始めるとき・描いている絵に足すときに参照画像にする。
 * 種類・大きさが合わなければ ApiError（kind: 'invalid_request'）を投げる
 */
export async function uploadConversationImage(
  conversationId: string,
  image: ReferenceUpload,
): Promise<ConversationUploadResponse> {
  return unwrap<ConversationUploadResponse>(() =>
    client.conversations[':conversationId'].uploads.$post({
      param: { conversationId },
      json: image,
    }),
  );
}

/** 中断する。turn は話す役のターンだけ、all は会話のジョブも止める */
export async function interruptConversation(
  conversationId: string,
  scope: 'turn' | 'all',
): Promise<void> {
  await unwrap<unknown>(() =>
    client.conversations[':conversationId'].interrupt.$post({
      param: { conversationId },
      json: { scope },
    }),
  );
}

/** 案を返すだけで何も保存しない。LLM 未設定は ApiError（kind: 'llm_not_configured'）、変換失敗は 'unparsable' */
export async function parseStopConditionsText(text: string): Promise<StopConditionsDraftResponse> {
  return unwrap<StopConditionsDraftResponse>(() =>
    client['stop-conditions'].parse.$post({ json: { text } }),
  );
}

/** 検証に落ちたとき（止まらない条件など）は ApiError（kind: 'invalid_request'）を投げる */
export async function createAutoJob(input: {
  request: string;
  stopConditions: StopConditions;
  batchSize: number;
  references?: ReferenceUpload[];
  /** このジョブだけの許可の上書き。書いた欄だけ。省けば全体の既定のまま */
  permissions?: PermissionOverridesInput;
}): Promise<CreateAutoJobResponse> {
  const created = await unwrap<CreateAutoJobResponse>(() =>
    client.jobs.auto.$post({ json: input }),
  );
  await mutate(keys.jobs);
  return created;
}

export async function stopJob(jobId: string): Promise<void> {
  await unwrap<unknown>(() => client.jobs.auto[':jobId'].stop.$post({ param: { jobId } }));
  await refreshJob(jobId);
}

/** 止まったジョブへは ApiError（status 409）、空の指示は 'invalid_request' を投げる */
export async function addInstruction(jobId: string, text: string): Promise<AddInstructionResponse> {
  const added = await unwrap<AddInstructionResponse>(() =>
    client.jobs.auto[':jobId'].interventions.$post({
      param: { jobId },
      json: { kind: 'instruction', text },
    }),
  );
  await refreshJob(jobId);
  await mutate(keys.interventions(jobId));
  return added;
}

/** 画像は1回に1枚。止まったジョブへは ApiError（status 409）、形式・大きさ・note の違反は 'invalid_request' を投げる */
export async function addReference(
  jobId: string,
  image: ReferenceUpload,
): Promise<AddReferenceResponse> {
  const added = await unwrap<AddReferenceResponse>(() =>
    client.jobs.auto[':jobId'].interventions.$post({
      param: { jobId },
      json: { kind: 'reference', image },
    }),
  );
  await refreshJob(jobId);
  await mutate(keys.interventions(jobId));
  await mutate(keys.references(jobId));
  return added;
}

/**
 * 回の画像1枚に塗った inpaint のマスクを送る。png は白い所を描き直す PNG を base64 にしたもの。
 * 止まったジョブへは ApiError（status 409）、無い画像へは 404、PNG でない・大きすぎるときは 'invalid_request' を投げる
 */
export async function addMask(
  jobId: string,
  image: { iteration: number; index: number },
  png: string,
): Promise<AddMaskResponse> {
  const added = await unwrap<AddMaskResponse>(() =>
    client.jobs.auto[':jobId'].interventions.$post({
      param: { jobId },
      json: { kind: 'mask', image, mask: { data: png } },
    }),
  );
  await refreshJob(jobId);
  await mutate(keys.interventions(jobId));
  return added;
}

/** 重ねたあとの実際の止める条件を返す。止まったジョブへは ApiError（status 409）を投げる */
export async function changeStopConditions(
  jobId: string,
  change: StopConditionsChange,
): Promise<ChangeStopConditionsResponse> {
  const changed = await unwrap<ChangeStopConditionsResponse>(() =>
    client.jobs.auto[':jobId'].interventions.$post({
      param: { jobId },
      json: { kind: 'stopConditions', stopConditions: change },
    }),
  );
  await refreshJob(jobId);
  await mutate(keys.interventions(jobId));
  await mutate(keys.stopConditions(jobId));
  return changed;
}

/** verdict が null のときは選択を外す */
export async function setSelection(
  jobId: string,
  imageKey: string,
  verdict: SelectionVerdict | null,
): Promise<SetSelectionResponse> {
  const set = await unwrap<SetSelectionResponse>(() =>
    client.jobs[':jobId'].selections[':imageKey'].$put({
      param: { jobId, imageKey },
      json: { verdict },
    }),
  );
  await mutate(keys.selections(jobId));
  return set;
}

/**
 * 画面の「採る」ボタン。人間が選んだ画像をジョブに採らせ、お気に入りにする（会話の adopt_image と同じ口）。
 * ジョブが止まっていれば 409、画像が無ければ 404 の ApiError を投げる
 */
export async function adoptImage(
  jobId: string,
  image: { iteration: number; index: number },
): Promise<AdoptImageResponse> {
  const adopted = await unwrap<AdoptImageResponse>(() =>
    client.jobs[':jobId'].adopt.$post({ param: { jobId }, json: image }),
  );
  // 選択（お気に入り）と、ジョブの状態・回（止まった・人が選んだ）を取り直す
  await Promise.all([
    mutate(keys.selections(jobId)),
    mutate(keys.iterations(jobId)),
    refreshJob(jobId),
  ]);
  return adopted;
}

// 一覧も取り直す: 止めた・口出しした直後に、一覧の状態が古いまま残らないようにするため
async function refreshJob(jobId: string): Promise<void> {
  await Promise.all([mutate(keys.job(jobId)), mutate(keys.jobs)]);
}

/**
 * 設定の画面の「確かめる」。drawroid doctor と同じ確かめ（設定・バックエンド・LLM・web の配り先）を走らせる。
 * LLM の返事を待つので、時間がかかることがある。何も書き換えないので、取り直すものは無い
 */
export async function runDoctor(): Promise<DoctorResponse> {
  return unwrap<DoctorResponse>(() => client.doctor.$post());
}

/** 生成の途中の画像を流すかを保存する。次に始まる生成から効く */
export async function saveGenerationProgressSettings(
  settings: GenerationProgressSettingsResponse,
): Promise<GenerationProgressSettingsResponse> {
  const saved = await unwrap<GenerationProgressSettingsResponse>(() =>
    client.settings['generation-progress'].$put({ json: settings }),
  );
  // 保存の応答は読む口と同じ形なので、取り直さずにそのまま置く
  await mutate(keys.generationProgressSettings, saved, { revalidate: false });
  return saved;
}
