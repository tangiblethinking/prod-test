import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Search } from "lucide-react";
import { searchJobs } from "@/lib/jobs.functions";
import {
  SOURCE_META,
  SOURCES,
  companyKey,
  emptyFilters,
  filterJobs,
  filtersAreActive,
  isSource,
  normalizeSlug,
  parseCompanies,
  sortJobs,
  sourceRank,
  uniqueCountries,
  uniqueSources,
  uniqueWorkModes,
  type BoardFailure,
  type Company,
  type Job,
  type JobFilters,
  type SortKey,
  type Source,
} from "@/lib/jobs";
import { BoardsPanel } from "./search-boards";
import { SearchResults } from "./search-results";
import {
  CHUNK,
  PAGE_SIZE,
  RESULT_CAP,
  STORE_KEY,
  SUGGESTIONS,
  groupJobs,
  loadStore,
  readableError,
  type Board,
  type PageSize,
  type Phase,
} from "./search-shared";

export function SearchApp({
  query,
  onQuery,
  onSend,
  sendDisabled,
}: {
  query: string;
  onQuery: (next: string) => void;
  onSend?: (job: Job) => void;
  sendDisabled?: boolean;
}) {
  const [draft, setDraft] = useState(query);
  const [boards, setBoards] = useState<Board[] | null>(null);
  const [disabled, setDisabled] = useState<Set<string>>(() => new Set());
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [boardsOpen, setBoardsOpen] = useState(false);
  const [addName, setAddName] = useState("");
  const [addSource, setAddSource] = useState<Source>("greenhouse");
  const [addSlug, setAddSlug] = useState("");
  const [addError, setAddError] = useState("");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [failed, setFailed] = useState<BoardFailure[]>([]);
  const [checked, setChecked] = useState(0);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showMisses, setShowMisses] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("source");
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [filters, setFilters] = useState<JobFilters>(() => emptyFilters());
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>(PAGE_SIZE);
  const baseRef = useRef<Company[]>([]);
  const runId = useRef(0);
  const booted = useRef(false);

  useEffect(() => {
    setDraft(query);
  }, [query]);

  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const response = await fetch(`${import.meta.env.BASE_URL}companies.json`);
        if (!response.ok) throw new Error("status");
        const base = parseCompanies(await response.json());
        const store = loadStore();
        if (cancel) return;
        const map = new Map<string, Board>();
        for (const company of base) map.set(companyKey(company), { ...company, builtin: true });
        for (const company of store.added) {
          const key = companyKey(company);
          if (!map.has(key)) map.set(key, { ...company, builtin: false });
        }
        baseRef.current = base;
        setDisabled(new Set(store.disabled));
        setBoards([...map.values()]);
        setReady(true);
      } catch {
        if (!cancel) setLoadError("The board list didn\u2019t load. Refresh and try again.");
      }
    })();
    return () => {
      cancel = true;
    };
  }, []);

  useEffect(() => {
    if (!ready || !boards) return;
    const added = boards.filter((board) => !board.builtin).map(({ name, source, slug }) => ({ name, source, slug }));
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ added, disabled: [...disabled] }));
    } catch {
      /* private mode */
    }
  }, [ready, boards, disabled]);

  const active = useMemo(
    () => (boards ?? []).filter((board) => !disabled.has(companyKey(board))),
    [boards, disabled],
  );

  async function execute(queryText: string, list: Company[]) {
    const id = ++runId.current;
    const q = queryText.trim().slice(0, 120);
    if (q.length < 2) {
      setPhase("error");
      setError("Enter at least 2 characters.");
      setNotice("");
      return;
    }
    const queued = list.slice(0, 80);
    if (queued.length === 0) {
      setPhase("error");
      setError("Turn on at least one board.");
      setNotice("");
      return;
    }
    setPhase("loading");
    setError("");
    setNotice(list.length > 80 ? "Only the first 80 boards are searched." : "");
    setJobs([]);
    setFailed([]);
    setChecked(0);
    setTotal(queued.length);
    setCursor("Checking boards\u2026");
    setShowMisses(false);
    setSortKey("source");
    setSortDir(1);
    setFilters(emptyFilters());
    setPage(1);
    onQuery(q);

    const acc: Job[] = [];
    const misses: BoardFailure[] = [];
    try {
      for (let i = 0; i < queued.length; i += CHUNK) {
        if (runId.current !== id) return;
        const slice = queued.slice(i, i + CHUNK);
        setCursor(slice.map((company) => company.name).join(", "));
        const payload = await searchJobs({ data: { query: q, companies: slice } });
        if (runId.current !== id) return;
        acc.push(...payload.jobs);
        misses.push(...payload.failed);
        setJobs(acc.slice());
        setFailed(misses.slice());
        setChecked(i + slice.length);
      }
      if (runId.current !== id) return;
      setCursor("");
      setPhase("done");
    } catch (err) {
      if (runId.current !== id) return;
      setCursor("");
      setPhase(acc.length > 0 ? "done" : "error");
      setError(readableError(err));
    }
  }

  useEffect(() => {
    if (!boards || booted.current) return;
    booted.current = true;
    const q = query.trim();
    if (q.length < 2) return;
    void execute(q, boards.filter((board) => !disabled.has(companyKey(board))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boards, disabled]);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!boards) return;
    void execute(draft, active);
  }

  function onSort(key: SortKey) {
    setPage(1);
    if (sortKey === key) setSortDir((dir) => (dir === 1 ? -1 : 1));
    else {
      setSortKey(key);
      setSortDir(1);
    }
  }

  function onFilters(next: JobFilters) {
    setPage(1);
    setFilters(next);
  }

  function onPageSize(size: PageSize) {
    setPageSize(size);
    setPage(1);
  }

  function toggleBoard(board: Board) {
    const key = companyKey(board);
    setDisabled((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function onAdd(event: FormEvent) {
    event.preventDefault();
    if (!boards) return;
    const name = addName.trim();
    const slug = normalizeSlug(addSource, addSlug);
    if (!name) {
      setAddError("Name the company.");
      return;
    }
    if (!slug) {
      setAddError("Slug doesn\u2019t match this source. Use the token from the careers URL.");
      return;
    }
    const next: Board = { name: name.slice(0, 80), source: addSource, slug, builtin: false };
    if (boards.some((board) => companyKey(board) === companyKey(next))) {
      setAddError("That board is already listed.");
      return;
    }
    if (boards.length >= 80) {
      setAddError("80 boards is the limit.");
      return;
    }
    setBoards([...boards, next]);
    setAddName("");
    setAddSlug("");
    setAddError("");
  }

  const filtered = useMemo(() => filterJobs(jobs, filters), [jobs, filters]);
  const sorted = useMemo(() => sortJobs(filtered, sortKey, sortDir).slice(0, RESULT_CAP), [filtered, sortKey, sortDir]);
  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const start = (safePage - 1) * pageSize;
  const visible = sorted.slice(start, start + pageSize);
  const grouped = sortKey === "source";
  const groups = grouped ? groupJobs(visible) : [];
  const sourceOptions = useMemo(() => {
    const seen = new Set(uniqueSources(jobs));
    return SOURCES.filter((source) => seen.has(source));
  }, [jobs]);
  const listed = [...(boards ?? [])].sort((a, b) => {
    const bySource = sourceRank(a.source) - sourceRank(b.source);
    return bySource !== 0 ? bySource : a.name.localeCompare(b.name);
  });

  return (
    <div className="flex w-full max-w-5xl flex-col gap-6">
      <header className="flex flex-col gap-3">
        <h1 className="font-display text-3xl font-medium leading-tight tracking-tight sm:text-4xl">Search company job boards</h1>
        <p className="max-w-xl text-sm text-muted-foreground sm:text-base">
          Search one title across public ATS boards. No search API key. Matches must include every word (small words like of, the, and a are ignored). Send a listing to the pipeline to align your resume.
        </p>
      </header>

      <form onSubmit={onSubmit} className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
        <div className="flex flex-col gap-2 sm:flex-row">
          <label className="sr-only" htmlFor="q">Job title</label>
          <input
            id="q"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Director of Product Design"
            autoComplete="off"
            enterKeyHint="search"
            className="min-h-11 w-full rounded-sm border border-border bg-background px-3 text-base text-foreground placeholder:text-muted-foreground"
          />
          <button type="submit" className="inline-flex min-h-11 items-center justify-center gap-2 rounded-sm bg-primary px-4 text-sm font-medium text-primary-foreground">
            <Search className="size-4" aria-hidden="true" />
            {phase === "loading" ? "Searching" : "Search"}
          </button>
        </div>
        <p className="text-sm text-muted-foreground tabular-nums">
          {boards ? `${active.length} of ${boards.length} boards on` : "Loading boards\u2026"}
          {loadError ? ` \u00b7 ${loadError}` : ""}
        </p>
      </form>

      {phase === "idle" ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm font-medium text-foreground">Try a title</p>
          <div className="flex flex-wrap gap-2">
            {SUGGESTIONS.map((title) => (
              <button
                key={title}
                type="button"
                onClick={() => {
                  setDraft(title);
                  if (boards) void execute(title, active);
                }}
                className="min-h-11 rounded-full border border-border bg-card px-4 text-sm text-foreground"
              >
                {title}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <BoardsPanel
        boards={boards}
        listed={listed}
        disabled={disabled}
        activeCount={active.length}
        open={boardsOpen}
        onToggleOpen={() => setBoardsOpen((open) => !open)}
        addName={addName}
        addSource={addSource}
        addSlug={addSlug}
        addError={addError}
        sourceHint={SOURCE_META.find((item) => item.id === addSource)?.hint ?? ""}
        onAddName={setAddName}
        onAddSource={setAddSource}
        onAddSlug={setAddSlug}
        onAdd={onAdd}
        onToggleBoard={toggleBoard}
        onRemove={(key) => setBoards((current) => (current ?? []).filter((item) => companyKey(item) !== key))}
        onRestore={() => {
          setBoards(baseRef.current.map((company) => ({ ...company, builtin: true })));
          setDisabled(new Set());
          setAddError("");
        }}
      />

      {phase !== "idle" ? (
        <SearchResults
          phase={phase}
          checked={checked}
          total={total}
          cursor={cursor}
          notice={notice}
          error={error}
          jobs={jobs}
          failed={failed}
          filteredCount={filtered.length}
          sortedCount={sorted.length}
          filterActive={filtersAreActive(filters)}
          showMisses={showMisses}
          onToggleMisses={() => setShowMisses((open) => !open)}
          modeOptions={uniqueWorkModes(jobs)}
          countryOptions={uniqueCountries(jobs)}
          sourceOptions={sourceOptions.filter(isSource)}
          filters={filters}
          onFilters={onFilters}
          visible={visible}
          grouped={grouped}
          groups={groups}
          sortKey={sortKey}
          sortDir={sortDir}
          onSort={onSort}
          page={safePage}
          pageCount={pageCount}
          pageSize={pageSize}
          onPage={setPage}
          onPageSize={onPageSize}
          onSend={onSend}
          sendDisabled={sendDisabled}
        />
      ) : null}
    </div>
  );
}
