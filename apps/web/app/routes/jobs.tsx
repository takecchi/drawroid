import { JobList } from '../components/job-list';

export default function Jobs() {
  return (
    <main style={{ maxWidth: 960, margin: '0 auto', padding: 16 }}>
      <h1>ジョブ</h1>
      <JobList />
    </main>
  );
}
