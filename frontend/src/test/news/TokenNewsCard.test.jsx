/**
 * TokenNewsCard tests (spec 109 US1): every FeedReading state renders its DISTINCT honest copy,
 * third-party content stays text-only, retry re-invokes the seam, not-configured renders nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import TokenNewsCard from '../../components/news/TokenNewsCard'
import { newsAgeLabel, newsBucket } from '../../lib/news/newsAge'

const mockFetchTokenNews = vi.fn()
vi.mock('../../lib/news/newsClient', () => ({
  fetchTokenNews: (...args) => mockFetchTokenNews(...args),
}))

const ITEM = {
  id: '1',
  title: 'A headline with <b>markup-looking</b> text',
  url: 'https://news.example/a',
  source: { name: 'Example Wire', slug: 'example' },
  publishedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
  sentiment: 1,
}

beforeEach(() => {
  mockFetchTokenNews.mockReset()
})

describe('TokenNewsCard', () => {
  it('renders read items as text with attribution, age, and an external link-out only', async () => {
    mockFetchTokenNews.mockResolvedValue({ state: 'read', items: [ITEM], fetchedAt: null, stale: false })
    render(<TokenNewsCard chainId={137} assetLabel="POL" />)
    const link = await screen.findByRole('link', { name: ITEM.title })
    expect(link).toHaveAttribute('href', ITEM.url)
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'))
    // Text-only rule: the markup-looking title renders as literal text, no injected <b>.
    expect(link.querySelector('b')).toBeNull()
    expect(screen.getByText(/Example Wire · 3h ago/)).toBeInTheDocument()
    // No third-party image ever renders.
    expect(document.querySelector('.token-news-card img')).toBeNull()
  })

  it('honest-empty and unreadable are DIFFERENT states with different words', async () => {
    mockFetchTokenNews.mockResolvedValue({ state: 'read', items: [], fetchedAt: null, stale: false })
    const { unmount } = render(<TokenNewsCard chainId={137} assetLabel="POL" />)
    expect(await screen.findByText('No recent items for POL.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    unmount()

    mockFetchTokenNews.mockResolvedValue({ state: 'unreadable', reason: 'upstream_unreachable' })
    render(<TokenNewsCard chainId={137} assetLabel="POL" />)
    expect(await screen.findByText('The news feed could not be read right now.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(screen.queryByText(/No recent items/)).toBeNull()
  })

  it('not-covered renders the honest absence sentence, no retry', async () => {
    mockFetchTokenNews.mockResolvedValue({ state: 'not-covered' })
    render(<TokenNewsCard chainId={137} address={'0x' + 'ab'.repeat(20)} assetLabel="MYSTERY" />)
    expect(await screen.findByText('No news source covers MYSTERY.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('not-configured renders NOTHING — no card, no empty affordance', async () => {
    mockFetchTokenNews.mockResolvedValue({ state: 'not-configured' })
    const { container } = render(<TokenNewsCard chainId={137} assetLabel="POL" />)
    await waitFor(() => expect(mockFetchTokenNews).toHaveBeenCalled())
    await waitFor(() => expect(container.innerHTML).toBe(''))
  })

  it('retry re-invokes the seam', async () => {
    mockFetchTokenNews.mockResolvedValueOnce({ state: 'unreadable', reason: 'gateway_unreachable' })
    mockFetchTokenNews.mockResolvedValueOnce({ state: 'read', items: [ITEM], fetchedAt: null, stale: false })
    render(<TokenNewsCard chainId={137} assetLabel="POL" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('link', { name: ITEM.title })).toBeInTheDocument()
    expect(mockFetchTokenNews).toHaveBeenCalledTimes(2)
  })

  it('newsAgeLabel is coarse and honest at every magnitude', () => {
    const now = Date.parse('2026-09-07T00:00:00Z')
    const at = (msAgo) => new Date(now - msAgo).toISOString()
    expect(newsAgeLabel(at(5 * 60_000), now)).toBe('5m ago')
    expect(newsAgeLabel(at(3 * 3600_000), now)).toBe('3h ago')
    expect(newsAgeLabel(at(5 * 86400_000), now)).toBe('5d ago')
    expect(newsAgeLabel(at(75 * 86400_000), now)).toBe('2mo ago')
    expect(newsAgeLabel('garbage', now)).toBe('')
  })

  // ── Layout (the ranked feed) ───────────────────────────────────────────────────────────────

  const at = (msAgo) => new Date(Date.now() - msAgo).toISOString()
  const HOUR = 3600_000
  const DAY = 86_400_000
  const item = (n, msAgo) => ({
    id: String(n),
    title: `Headline ${n}`,
    url: `https://news.example/${n}`,
    source: { name: `Source ${n}`, slug: `s${n}` },
    publishedAt: at(msAgo),
  })

  it('features the NEWEST item and caps first paint at featured + 3, whatever order the vendor sent', async () => {
    // Deliberately out of order: ranking is ours, from the dates, not the vendor's array index.
    const items = [item(3, 5 * HOUR), item(1, 1 * HOUR), item(5, 9 * HOUR), item(2, 3 * HOUR), item(4, 7 * HOUR), item(6, 11 * HOUR)]
    mockFetchTokenNews.mockResolvedValue({ state: 'read', items, fetchedAt: null, stale: false })
    const { container } = render(<TokenNewsCard chainId={137} assetLabel="POL" />)

    const featured = await screen.findByRole('link', { name: 'Headline 1' })
    expect(featured).toHaveClass('token-news-featured-link')
    // Four visible, in date order, and nothing beyond the cap.
    expect([...container.querySelectorAll('.token-news-link')].map((a) => a.textContent)).toEqual([
      'Headline 2',
      'Headline 3',
      'Headline 4',
    ])
    expect(screen.queryByRole('link', { name: 'Headline 5' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Headline 6' })).toBeNull()
  })

  it('the tail is one disclosure: collapsed rows are UNMOUNTED, not hidden, and expand on demand', async () => {
    const items = [item(1, 1 * HOUR), item(2, 2 * HOUR), item(3, 3 * HOUR), item(4, 4 * HOUR), item(5, 5 * HOUR), item(6, 6 * HOUR)]
    mockFetchTokenNews.mockResolvedValue({ state: 'read', items, fetchedAt: null, stale: false })
    render(<TokenNewsCard chainId={137} assetLabel="POL" />)

    // Everything hidden here is hours old, so calling it "Earlier" would be untrue.
    const more = await screen.findByRole('button', { name: /Show 2 older/ })
    expect(more).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('link', { name: 'Headline 6' })).toBeNull()

    fireEvent.click(more)
    expect(more).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('link', { name: 'Headline 6' })).toBeInTheDocument()
  })

  it('names the tail "Earlier" only when the tail really is older than a week', async () => {
    const items = [item(1, 1 * HOUR), item(2, 2 * HOUR), item(3, 3 * HOUR), item(4, 4 * HOUR), item(5, 60 * DAY), item(6, 90 * DAY)]
    mockFetchTokenNews.mockResolvedValue({ state: 'read', items, fetchedAt: null, stale: false })
    render(<TokenNewsCard chainId={137} assetLabel="POL" />)
    expect(await screen.findByRole('button', { name: /Earlier · 2/ })).toBeInTheDocument()
  })

  it('emits a recency heading only where the bucket CHANGES', async () => {
    const items = [item(1, 1 * HOUR), item(2, 2 * HOUR), item(3, 3 * DAY), item(4, 40 * DAY)]
    mockFetchTokenNews.mockResolvedValue({ state: 'read', items, fetchedAt: null, stale: false })
    const { container } = render(<TokenNewsCard chainId={137} assetLabel="POL" />)
    await screen.findByRole('link', { name: 'Headline 1' })
    // Headline 2 shares the featured item's bucket, so it gets no "Today" label over it.
    expect([...container.querySelectorAll('.token-news-bucket')].map((h) => h.textContent)).toEqual([
      'This week',
      'Earlier',
    ])
  })

  it('a single item is the featured one, with no compact list and no disclosure', async () => {
    mockFetchTokenNews.mockResolvedValue({ state: 'read', items: [ITEM], fetchedAt: null, stale: false })
    const { container } = render(<TokenNewsCard chainId={137} assetLabel="POL" />)
    await screen.findByRole('link', { name: ITEM.title })
    expect(container.querySelectorAll('.token-news-item')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: /older|Earlier/ })).toBeNull()
  })

  it('newsBucket is coarse and buries an unparseable date rather than featuring it', () => {
    const now = Date.parse('2026-09-08T12:00:00Z')
    const ago = (ms) => new Date(now - ms).toISOString()
    expect(newsBucket(ago(2 * HOUR), now)).toBe('today')
    expect(newsBucket(ago(3 * DAY), now)).toBe('week')
    expect(newsBucket(ago(30 * DAY), now)).toBe('earlier')
    expect(newsBucket('garbage', now)).toBe('earlier')
  })
})
