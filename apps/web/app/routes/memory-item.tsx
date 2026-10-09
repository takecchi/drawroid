import { Page } from '@drawroid/ui';
import { useParams } from 'react-router';

import { MemoryItemView } from '../components/memory-item-view';

export default function MemoryItemRoute() {
  const { id } = useParams();
  return <Page>{id !== undefined && <MemoryItemView id={id} />}</Page>;
}
