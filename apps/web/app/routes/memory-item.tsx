import { useParams } from 'react-router';

import { MemoryItemView } from '../components/memory-item-view';

export default function MemoryItemRoute() {
  const { id } = useParams();
  return (
    <main style={{ maxWidth: 960, margin: '0 auto', padding: 16 }}>
      {id !== undefined && <MemoryItemView id={id} />}
    </main>
  );
}
