"use client";

/**
 * The probe's edge report card: what the probe found the learner knows,
 * rendered in the transcript at the probe-edge marker's position. User-side
 * scaffolding in the build-card register, never a chat bubble. "Start here"
 * is the one emphasised element; Solid, Not reached yet and Questions start
 * collapsed.
 */

import { useId, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

// mirrors src/core/probe-edge.ts EdgeReport
interface EdgeFact {
	id: string;
	statement: string;
}
interface TrailRow {
	n: number;
	fact: string;
	question: string;
	answer: string;
	mark: string;
}
interface EdgeReport {
	goal: string;
	solid: (EdgeFact & { tested: boolean })[];
	weak: EdgeFact[];
	holes: (EdgeFact & { quote: string | null })[];
	wrongIdeas: (EdgeFact & { believed: string | null; quote: string | null })[];
	notReached: EdgeFact[];
	startHere: EdgeFact[];
	partly?: (EdgeFact & { held: string; missing: string })[];
	questions: number;
	trail?: TrailRow[];
}

export interface ProbeEdgeData {
	report?: EdgeReport;
}

const isFactList = (v: unknown): v is EdgeFact[] =>
	Array.isArray(v) &&
	v.every((f) => typeof f === "object" && f !== null && typeof (f as EdgeFact).id === "string" && typeof (f as EdgeFact).statement === "string");

const isPartlyList = (v: unknown): v is NonNullable<EdgeReport["partly"]> =>
	isFactList(v) && v.every((f) => typeof (f as { held?: unknown }).held === "string" && typeof (f as { missing?: unknown }).missing === "string");

const isTrail = (v: unknown): v is TrailRow[] =>
	Array.isArray(v) &&
	v.every((r) => {
		const row = r as Partial<TrailRow> | null;
		return (
			typeof row === "object" && row !== null && typeof row.n === "number" &&
			[row.fact, row.question, row.answer, row.mark].every((s) => typeof s === "string")
		);
	});

function readReport(data: unknown): EdgeReport | null {
	const report = (data as ProbeEdgeData | null | undefined)?.report as Partial<EdgeReport> | undefined;
	if (typeof report !== "object" || report === null) return null;
	if (typeof report.goal !== "string" || typeof report.questions !== "number") return null;
	const lists = [report.solid, report.weak, report.holes, report.wrongIdeas, report.notReached, report.startHere];
	if (!lists.every(isFactList)) return null;
	return {
		...(report as EdgeReport),
		partly: isPartlyList(report.partly) ? report.partly : undefined,
		trail: isTrail(report.trail) ? report.trail : undefined,
	};
}

function Section({
	title,
	count,
	collapsible = false,
	children,
}: {
	title: string;
	count?: number;
	collapsible?: boolean;
	children: ReactNode;
}) {
	const [open, setOpen] = useState(!collapsible);
	const listId = useId();
	const countEl = count !== undefined && <span className="shrink-0 tabular-nums text-muted-foreground">{count}</span>;
	return (
		<section className="space-y-1.5">
			<h4 className="text-xs font-medium text-foreground/80">
				{collapsible ? (
					<button
						type="button"
						aria-expanded={open}
						aria-controls={listId}
						onClick={() => setOpen((v) => !v)}
						className="flex w-full cursor-pointer items-baseline gap-2 text-left transition-colors hover:text-foreground"
					>
						<span className="min-w-0 flex-1">{title}</span>
						{countEl}
					</button>
				) : (
					<span className="flex items-baseline gap-2">
						<span className="min-w-0 flex-1">{title}</span>
						{countEl}
					</span>
				)}
			</h4>
			{open && (
				<ul id={listId} className="space-y-1.5">
					{children}
				</ul>
			)}
		</section>
	);
}

function FactRow({ glyph, glyphClass, children }: { glyph: string; glyphClass: string; children: ReactNode }) {
	return (
		<li className="flex items-baseline gap-2 text-xs leading-relaxed">
			<span aria-hidden="true" className={cn("w-3 shrink-0 text-center font-mono", glyphClass)}>
				{glyph}
			</span>
			<div className="min-w-0 flex-1">{children}</div>
		</li>
	);
}

export function ProbeEdgeCard({ data }: { data: unknown }) {
	const report = readReport(data);
	if (!report) return null;
	const { goal, startHere, holes, partly, wrongIdeas, weak, solid, notReached, questions, trail } = report;
	return (
		<div data-testid="probe-edge-card" className="my-2 space-y-4 rounded-lg border border-border/70 px-4 py-3">
			<div className="flex items-baseline gap-3">
				<h3 className="shrink-0 font-ui text-xs font-medium uppercase tracking-wide text-muted-foreground">Your edge</h3>
				<span title={goal} className="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground">
					{goal}
				</span>
			</div>

			{startHere.length > 0 && (
				<section className="space-y-1.5">
					<h4 className="text-xs font-medium text-foreground/80">Start here</h4>
					<ul className="space-y-1 border-l-2 border-primary pl-3">
						{startHere.map((f) => (
							<li key={f.id} className="font-prose text-sm font-medium leading-relaxed text-foreground">
								{f.statement}
							</li>
						))}
					</ul>
				</section>
			)}

			{holes.length > 0 && (
				<Section title="Holes" count={holes.length}>
					{holes.map((f) => (
						<FactRow key={f.id} glyph="✗" glyphClass="text-error">
							<span className="text-foreground/90">{f.statement}</span>
							{f.quote && <div className="text-muted-foreground">“{f.quote}”</div>}
						</FactRow>
					))}
				</Section>
			)}

			{partly && partly.length > 0 && (
				<Section title="Partly known" count={partly.length}>
					{partly.map((f) => (
						<FactRow key={f.id} glyph="◐" glyphClass="text-warning">
							<span className="text-foreground/90">{f.statement}</span>
							<div className="text-muted-foreground">has: {f.held}</div>
							<div className="text-muted-foreground">lacks: {f.missing}</div>
						</FactRow>
					))}
				</Section>
			)}

			{wrongIdeas.length > 0 && (
				<Section title="Wrong ideas" count={wrongIdeas.length}>
					{wrongIdeas.map((f) => (
						<FactRow key={f.id} glyph="!" glyphClass="text-warning">
							<span className="text-foreground/90">{f.statement}</span>
							{f.believed && <div className="text-muted-foreground">you chose: {f.believed}</div>}
						</FactRow>
					))}
				</Section>
			)}

			{weak.length > 0 && (
				<Section title="Weak" count={weak.length}>
					{weak.map((f) => (
						<FactRow key={f.id} glyph="~" glyphClass="text-muted-foreground">
							<span className="text-foreground/90">{f.statement}</span>
						</FactRow>
					))}
				</Section>
			)}

			{solid.length > 0 && (
				<Section title="Solid" count={solid.length} collapsible>
					{solid.map((f) => (
						<FactRow key={f.id} glyph="✓" glyphClass="text-success">
							<span className="text-foreground/90">{f.statement}</span>
							{!f.tested && <span className="ml-1.5 text-muted-foreground">assumed</span>}
						</FactRow>
					))}
				</Section>
			)}

			{notReached.length > 0 && (
				<Section title="Not reached yet" count={notReached.length} collapsible>
					{notReached.map((f) => (
						<FactRow key={f.id} glyph="·" glyphClass="text-muted-foreground">
							<span className="text-muted-foreground">{f.statement}</span>
						</FactRow>
					))}
				</Section>
			)}

			{trail && trail.length > 0 && (
				<Section title="Questions" count={trail.length} collapsible>
					{trail.map((row) => (
						<li key={row.n} className="text-xs leading-relaxed">
							<div className="text-foreground/90">
								<span className="tabular-nums">{row.n}.</span> {row.fact} — {row.answer} → {row.mark}
							</div>
							<div className="text-muted-foreground">{row.question}</div>
						</li>
					))}
				</Section>
			)}

			<div className="text-xs tabular-nums text-muted-foreground">
				{questions} {questions === 1 ? "question" : "questions"}
			</div>
		</div>
	);
}
