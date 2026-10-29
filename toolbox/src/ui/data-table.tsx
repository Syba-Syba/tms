import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';
import { useState } from 'react';
import { cn } from '../lib/cn';
import { EmptyState } from './empty-state';
import { Pagination } from './pagination';

export function DataTable<T>({
  data,
  columns,
  pageSize = 20,
  emptyTitle = 'Nothing here yet',
  className,
}: {
  data: T[];
  columns: ColumnDef<T, unknown>[];
  pageSize?: number;
  emptyTitle?: string;
  className?: string;
}) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize } },
  });

  if (!data.length) return <EmptyState title={emptyTitle} />;

  return (
    <div className={cn('space-y-3', className)}>
      <div className="overflow-x-auto rounded-md border border-line bg-surface">
        <table className="w-full text-body">
          <thead className="border-b border-line text-left">
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => (
                  <th
                    key={header.id}
                    onClick={header.column.getToggleSortingHandler()}
                    className="cursor-pointer px-4 py-2.5 text-xs font-medium text-ink-muted"
                  >
                    {flexRender(header.column.columnDef.header, header.getContext())}
                    {{ asc: ' up', desc: ' down' }[header.column.getIsSorted() as string] ?? ''}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr key={row.id} className="border-t border-line-soft hover:bg-surface-muted">
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="px-4 py-3 tabular-nums text-ink">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination
        page={table.getState().pagination.pageIndex + 1}
        pageCount={table.getPageCount()}
        onPageChange={(next) => table.setPageIndex(next - 1)}
      />
    </div>
  );
}
