// 本番の doctor が、設定の画面の「確かめる」（POST /api/doctor）に返した応答（fixtures/doctor.json）。取り方は fixtures/README.md
import type { DoctorResponse } from '@drawroid/swr';

import doctorJson from './fixtures/doctor.json';

export const recordedDoctor = doctorJson satisfies DoctorResponse;
