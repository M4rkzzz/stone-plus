/**
 * Keep the live request table small enough to reconcile within one frame.
 * The full renderer snapshot remains available for filtering and export.
 */
export const REQUEST_LOG_RENDER_PAGE_SIZE = 100

export interface RequestLogPage<T> {
  items: T[]
  page: number
  pageCount: number
  start: number
  end: number
  total: number
}

export function paginateRequestLogs<T>(
  items: readonly T[],
  requestedPage: number,
): RequestLogPage<T> {
  const total = items.length
  const pageCount = Math.max(1, Math.ceil(total / REQUEST_LOG_RENDER_PAGE_SIZE))
  const normalizedPage = Number.isFinite(requestedPage) ? Math.trunc(requestedPage) : 0
  const page = Math.max(0, Math.min(pageCount - 1, normalizedPage))
  const offset = page * REQUEST_LOG_RENDER_PAGE_SIZE
  const pageItems = items.slice(offset, offset + REQUEST_LOG_RENDER_PAGE_SIZE)

  return {
    items: pageItems,
    page,
    pageCount,
    start: total === 0 ? 0 : offset + 1,
    end: offset + pageItems.length,
    total,
  }
}
