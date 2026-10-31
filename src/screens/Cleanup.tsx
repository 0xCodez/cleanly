import { useEffect, useMemo, useRef, useState } from 'react';
import type { JunkCategory } from '../../shared/types';
import { Icon } from '../components/Icon';
import { CleanButton, Empty, Progress, ScreenHead } from '../components/ui';
import { formatBytes, shortPath, splitBytes, sum } from '../lib/format';
import { useStore } from '../state';
import './files.css';

const isPermanent = (c: JunkCategory) => /recycle|trash/i.test(`${c.id} ${c.name}`);

export default function Cleanup() {
  const { junk, scanning, smartScan, progress, cleaning, cleanJunk, system, settings, toast } = useStore();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);

  // scan once on arrival; a failed scan leaves the retry button below instead of looping
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current || junk || scanning) return;
    asked.current = true;
    void smartScan();
  }, [junk, scanning, smartScan]);

  // a fresh scan result resets the selection to the safe categories
  useEffect(() => {
    setSelected(new Set((junk ?? []).filter((c) => c.safe && c.size > 0).map((c) => c.id)));
    setConfirming(false);
  }, [junk]);

  const items = useMemo(() => [...(junk ?? [])].sort((a, b) => Number(b.safe) - Number(a.safe) || b.size - a.size), [junk]);
  const chosen = items.filter((c) => selected.has(c.id) && c.size > 0);
  const total = sum(chosen.map((c) => c.size));
  const files = sum(chosen.map((c) => c.count));
  const hasPermanent = chosen.some(isPermanent);
  const cleanable = items.filter((c) => c.size > 0);
  const allOn = cleanable.length > 0 && cleanable.every((c) => selected.has(c.id));
  const home = system?.homeDir;
  const scanProg = progress?.task === 'junk' ? progress : null;
  const cleanProg = progress?.task === 'clean' ? progress : null;

  const toggle = (id: string) => {
    setDone(false);
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const toggleAll = () => setSelected(allOn ? new Set() : new Set(cleanable.map((c) => c.id)));

  const run = async () => {
    setConfirming(false);
    const ids = chosen.map((c) => c.id);
    const result = await cleanJunk(ids);
    if (!result) return;
    setDone(true);
    const extra = result.skipped.length
      ? ` · ${result.skipped.slice(0, 2).join(', ')}`
      : result.failed > 0
        ? ` · ${result.failed} 个正在使用，已跳过`
        : '';
    toast(`已释放 ${formatBytes(result.freed)}${extra}`);
  };

  const start = () => {
    if (!chosen.length) return;
    if (settings?.confirmBeforeClean === false) void run();
    else setConfirming(true);
  };

  const big = splitBytes(total);

  return (
    <div className="screen">
      <ScreenHead title="清理" sub="缓存、临时文件和日志，应用会自动重建。已为你选好安全项。">
        <div className="fx-head-actions">
          <button type="button" className="btn small" onClick={() => void smartScan()} disabled={scanning || cleaning}>
            {scanning ? <span className="spinner" /> : <Icon name="scan" />}
            {scanning ? '正在扫描' : '重新扫描'}
          </button>
        </div>
      </ScreenHead>

      {!junk && scanning && (
        <section className="card-w rise">
          <div className="fx-wait">
            <span className="orb">
              <Icon name="broom" />
            </span>
            <h3>正在查找垃圾文件</h3>
            <p>{scanProg?.phase ?? '正在检查缓存、临时文件夹和日志'}</p>
            <Progress value={scanProg && scanProg.total > 0 ? scanProg.done / scanProg.total : undefined} />
            {scanProg?.current && <div className="cur">{shortPath(scanProg.current, home)}</div>}
          </div>
        </section>
      )}

      {!junk && !scanning && (
        <section className="card-w rise">
          <Empty icon="scan" title="尚未扫描" text="运行一次快速扫描，看看哪些可以清理。">
            <button type="button" className="btn primary" onClick={() => void smartScan()}>
              <Icon name="scan" /> 立即扫描
            </button>
          </Empty>
        </section>
      )}

      {junk && (
        <section className="card-w fx-panel rise" style={{ animationDelay: '0.06s' }}>
          {scanning && (
            <div className="fx-strip">
              <span className="spinner" />
              <span>{scanProg?.phase ?? '正在重新扫描'}</span>
              <Progress value={scanProg && scanProg.total > 0 ? scanProg.done / scanProg.total : undefined} />
            </div>
          )}
          <div className="fx-panel-head">
            <h2>扫描结果</h2>
            <span className="fx-count">
              {items.length} 类中有 {cleanable.length} 类可清理
            </span>
            <span className="grow" />
            <button type="button" className="fx-link" onClick={toggleAll} disabled={!cleanable.length || cleaning}>
              {allOn ? '取消全选' : '全选'}
            </button>
          </div>
          {cleanable.length === 0 && !scanning ? (
            <Empty icon="check" title="全部干净" text="目前没有需要删除的内容。过几天再来看看。" />
          ) : (
            <div className="list fx-list">
              {items.map((c) => {
                const empty = c.size <= 0;
                const on = selected.has(c.id) && !empty;
                const perm = isPermanent(c);
                return (
                  <label key={c.id} className={`row${on ? ' on' : ''}${empty ? ' off' : ''}`}>
                    <input type="checkbox" className="check" checked={on} disabled={empty || cleaning} onChange={() => toggle(c.id)} aria-label={c.name} />
                    <span className={`chip-ico${perm ? ' warm' : c.safe ? '' : ' mute'}`}>
                      <Icon name={c.icon} />
                    </span>
                    <div className="grow">
                      <div className="title">{c.name}</div>
                      <div className="fx-desc">{c.description}</div>
                      <div className="sub mono" title={c.locations.join('\n')}>
                        {c.locations.map((l) => shortPath(l, home)).join('  ·  ')}
                      </div>
                    </div>
                    <div className="tags">
                      {perm && (
                        <span className="tag keep">
                          <Icon name="warning" />
                          永久删除
                        </span>
                      )}
                      {!empty && <span className={`tag ${c.safe ? 'safe' : 'review'}`}>{c.safe ? '安全' : '需确认'}</span>}
                    </div>
                    <span className="size">{empty ? '已清理' : formatBytes(c.size)}</span>
                  </label>
                );
              })}
            </div>
          )}
        </section>
      )}

      {junk && cleanable.length > 0 && (
        confirming ? (
          <div className="fx-dock" role="alertdialog" aria-label="确认清理">
            <span className={`chip-ico${hasPermanent ? ' warm' : ''}`}>
              <Icon name={hasPermanent ? 'warning' : 'broom'} />
            </span>
            <div className="grow">
              <div className="fx-dock-q">删除 {formatBytes(total)} 的缓存和垃圾文件？</div>
              {hasPermanent ? (
                <div className="fx-dock-note warn">包括清空回收站，此部分无法撤销。</div>
              ) : (
                <div className="fx-dock-note">应用需要时会自动重建。</div>
              )}
            </div>
            <button type="button" className="btn ghost" onClick={() => setConfirming(false)}>
              取消
            </button>
            <button type="button" className={`btn primary${hasPermanent ? ' danger' : ''}`} onClick={() => void run()} autoFocus>
              删除
            </button>
          </div>
        ) : (
          <div className="fx-dock">
            <div className="grow">
              <div className="fx-dock-num">
                {big.value}
                <small>{big.unit} 已选</small>
              </div>
              <div className="fx-dock-sub">
                {cleaning
                  ? cleanProg?.phase ?? '正在清理'
                  : `${chosen.length} 个类别 · ${files.toLocaleString('zh-CN')} 项`}
              </div>
            </div>
            {cleaning && <Progress value={cleanProg && cleanProg.total > 0 ? cleanProg.done / cleanProg.total : undefined} />}
            <CleanButton
              label={cleaning ? '正在清理' : done && !chosen.length ? '已完成' : '清理'}
              sub={formatBytes(total)}
              busy={cleaning}
              done={done && !chosen.length}
              disabled={!chosen.length || scanning}
              onClick={start}
            />
          </div>
        )
      )}
    </div>
  );
}
