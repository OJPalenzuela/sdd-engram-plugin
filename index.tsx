/** @jsxImportSource @opentui/solid */
/**
 * SDD Model Select — OpenCode V2 native `./tui` entry.
 *
 * Total V2 cutover: `./tui` IS V2 (no parallel `./tui-v2`). This file is
 * built as `dist/tui.js` via `Plugin.define` from `@opencode/plugin/tui`.
 *
 * V1 -> V2 mapping applied here:
 * - `api.kv` -> `context.storage.store("sdd-prefs", ...)` (durable JSON).
 *   V2 storage starts fresh; V1 kv keys (`sdd-show-model-badge`, ...) are
 *   NOT migrated automatically.
 * - slots `home_bottom`/`sidebar_content` -> `home.footer.status` /
 *   `sidebar.content` via `context.ui.slot`.
 * - `api.keymap.registerLayer` -> `context.keymap.layer` inside the mounted
 *   `SddGlobalKeymap` component (mode `global`, one palette command).
 * - `api.ui.dialog` JSX components -> promise-based
 *   `context.ui.dialog.select/confirm/prompt` + `context.ui.toast.show`.
 *
 * Full 15-dialog port is deferred: every stub below names the V1 source in
 * src/dialogs.tsx to port next.
 */

import * as path from "node:path";
import { Plugin, usePlugin } from "@opencode/plugin/tui";
import type { Context } from "@opencode/plugin/tui/context";
import { Show } from "solid-js";
import { formatActiveModelBadgeText } from "./components";
import { createLogger } from "./src/logger";
import { listProjectMemories } from "./src/memories";
import { listProfileFiles } from "./src/profiles";
import type { ActiveProfileState } from "./src/types";
import { isPrimarySddAgent } from "./src/utils";

const log = createLogger("tui");

const ENGRAM_PORT_NAME = "ENGRAM_PORT";
const ENGRAM_HOST = "127.0.0.1";

type SddPrefs = {
	badgeVisible: boolean;
	displayMode: "model" | "profile";
	activeProfileName: string;
};

const initialPrefs: SddPrefs = {
	badgeVisible: true,
	displayMode: "model",
	activeProfileName: "",
};

/**
 * Converts a V2 theme token to a `#rrggbb` string for `fg` props.
 * V2 tokens are `RGBA` class instances (see `@opencode/theme`); plain CSS
 * strings pass through and anything else falls back.
 */
export function rgbaToHex(color: unknown, fallback = "#888888"): string {
	if (typeof color === "string" && color.length > 0) return color;
	try {
		const candidate = color as {
			toInts?: () => [number, number, number, number];
			r?: unknown;
			g?: unknown;
			b?: unknown;
		};
		if (typeof candidate?.toInts === "function") {
			const [r, g, b] = candidate.toInts();
			return intsToHex(r, g, b);
		}
		if (
			typeof candidate?.r === "number" &&
			typeof candidate?.g === "number" &&
			typeof candidate?.b === "number"
		) {
			// Accept 0-1 floats or 0-255 ints.
			const scale = candidate.r <= 1 && candidate.g <= 1 && candidate.b <= 1 ? 255 : 1;
			return intsToHex(candidate.r * scale, candidate.g * scale, candidate.b * scale);
		}
	} catch (error) {
		log.warn("rgbaToHex: failed to convert theme token", error);
	}
	return fallback;
}

function intsToHex(r: number, g: number, b: number): string {
	const channel = (value: number): string =>
		Math.max(0, Math.min(255, Math.round(value)))
			.toString(16)
			.padStart(2, "0");
	return `#${channel(r)}${channel(g)}${channel(b)}`;
}

function resolveProjectName(context: Context): string {
	const directory = context.location?.directory;
	if (!directory) return "project";
	const base = path.basename(directory).trim().toLowerCase();
	return base || "project";
}

function resolveSessionAgentName(context: Context, sessionID?: string): string | undefined {
	if (!sessionID) return undefined;
	try {
		const messages = context.data.session.message.list(sessionID) ?? [];
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const agent = (messages[index] as unknown as { agent?: unknown })?.agent;
			if (typeof agent === "string" && agent.length > 0) return agent;
		}
	} catch (error) {
		log.warn("resolveSessionAgentName: failed to read session messages", error);
	}
	return undefined;
}

/** Ports the V1 badge/profile read to `data.location.agent.list`. */
function resolveBadgeProfile(context: Context, sessionID?: string): ActiveProfileState | null {
	try {
		const agents = context.data.location.agent.list(context.location) ?? [];
		const sddAgents = agents.filter((agent) => isPrimarySddAgent(agent.name));
		if (sddAgents.length === 0) return null;

		const sessionAgent = resolveSessionAgentName(context, sessionID);
		const selected =
			sddAgents.find((agent) => agent.name === sessionAgent) ?? sddAgents[0];
		if (!selected) return null;

		const model = selected.model;
		if (!model) return null;
		const models = context.data.location.model.list(context.location) ?? [];
		const info = models.find(
			(entry) => entry.providerID === model.providerID && entry.modelID === model.id,
		);
		return {
			modelId: `${model.providerID}/${model.id}`,
			modelName: info?.name ?? model.id,
			providerName: model.providerID,
			contextLimit: info?.limit?.context ?? null,
		};
	} catch (error) {
		log.warn("resolveBadgeProfile: failed to resolve badge profile", error);
		return null;
	}
}

/**
 * Lists recent Engram observations for the current project.
 * Prefers `context.client` when it can serve observations; the V2 client
 * exposes no observations endpoint today, so this keeps the raw Engram HTTP
 * fetch (`http://127.0.0.1:7437`, port via `ENGRAM_PORT`) shared with V1.
 */
async function countRecentMemories(context: Context): Promise<number> {
	try {
		const memories = await listProjectMemories({
			state: { path: { directory: context.location?.directory } },
		});
		return memories.length;
	} catch (error) {
		log.warn(
			`countRecentMemories: Engram fetch to ${ENGRAM_HOST} failed (port via ${ENGRAM_PORT_NAME})`,
			error,
		);
		return 0;
	}
}

function toast(context: Context, options: { title?: string; message: string; variant?: "info" | "success" | "warning" | "error" }): void {
	try {
		context.ui.toast.show(options);
	} catch (error) {
		log.warn("toast: failed to show toast", error);
	}
}

async function openProfileHub(
	context: Context,
	fileName: string,
): Promise<void> {
	const title = fileName.replace(/\.json$/, "");
	const choice = await context.ui.dialog.select({
		title: `Profile: ${title}`,
		options: [
			{ title: "Activate profile", value: "activate", description: "Apply to global configuration" },
			{ title: "Rename profile", value: "rename", description: "Rename the profile file" },
			{ title: "Back", value: "__back__" },
		],
	});
	if (choice === "activate") {
		const confirmed = await context.ui.dialog.confirm({
			title: "Activate profile",
			message: `Apply '${title}' to the global configuration?`,
		});
		if (!confirmed) return;
		// TODO(tui-v2): port activation (V1 src/dialogs.tsx handleActivateProfile ~line 856).
		toast(context, { title: "Not yet ported", message: `Activation of '${title}' lands with the full dialog port.`, variant: "warning" });
		return;
	}
	if (choice === "rename") {
		const next = await context.ui.dialog.prompt({ title: "Rename profile", value: title });
		if (!next || next.trim() === title) return;
		// TODO(tui-v2): port rename (V1 src/dialogs.tsx showRenameProfile ~line 907).
		toast(context, { title: "Not yet ported", message: `Rename to '${next.trim()}' lands with the full dialog port.`, variant: "warning" });
	}
}

async function openProfileList(context: Context): Promise<void> {
	let files: string[];
	try {
		files = listProfileFiles();
	} catch (error) {
		log.warn("openProfileList: failed to list profiles", error);
		files = [];
	}
	if (files.length === 0) {
		toast(context, { title: "No profiles", message: "No saved profiles found. Create one first!", variant: "warning" });
		return;
	}
	const choice = await context.ui.dialog.select({
		title: "Select SDD profile",
		options: [
			...files.map((file) => ({
				title: file.replace(/\.json$/, ""),
				value: file,
				description: "SDD profile",
			})),
			{ title: "Back", value: "__back__" },
		],
	});
	if (!choice || choice === "__back__") return;
	// TODO(tui-v2): port full detail hub (V1 src/dialogs.tsx showProfileDetail ~line 662).
	await openProfileHub(context, choice);
}

async function openProfilesMenu(
	context: Context,
	prefs: SddPrefs,
	updatePrefs: (mutation: (draft: SddPrefs) => void) => Promise<void>,
): Promise<void> {
	const choice = await context.ui.dialog.select({
		title: "SDD Profile Management",
		options: [
			{ title: "Create new SDD profile", value: "create", description: "Create an empty SDD profile" },
			{ title: "Manage SDD profiles", value: "list", description: "List and activate saved SDD profiles" },
			{ title: "View project memories", value: "memories", description: "Show recent Engram observations" },
			{ title: `Badge: ${prefs.badgeVisible ? "On" : "Off"}`, value: "toggle_badge", description: "Show or hide the badge" },
			{ title: `Badge mode: ${prefs.displayMode === "profile" ? "Profile" : "Model"}`, value: "toggle_mode", description: "Show model info or profile name" },
			{ title: "Close", value: "__close__" },
		],
	});
	if (choice === "create") {
		const name = await context.ui.dialog.prompt({ title: "New SDD profile name", placeholder: "Enter profile name" });
		if (!name || !name.trim()) return;
		// TODO(tui-v2): port creation (V1 src/dialogs.tsx showCreateProfile ~line 555).
		toast(context, { title: "Not yet ported", message: `Creation of '${name.trim()}' lands with the full dialog port.`, variant: "warning" });
	} else if (choice === "list") {
		// TODO(tui-v2): port remaining list flows (V1 src/dialogs.tsx showProfileList ~line 618).
		await openProfileList(context);
	} else if (choice === "memories") {
		// TODO(tui-v2): port memory dialogs (V1 src/dialogs.tsx showProjectMemoriesMenu ~line 1290).
		const count = await countRecentMemories(context);
		toast(context, {
			title: "Project memories",
			message: count > 0
				? `${count} recent observations for ${resolveProjectName(context)}. Full browser lands with the dialog port.`
				: `No project observations found for ${resolveProjectName(context)}.`,
			variant: count > 0 ? "success" : "warning",
		});
	} else if (choice === "toggle_badge") {
		await updatePrefs((draft) => {
			draft.badgeVisible = !draft.badgeVisible;
		});
		toast(context, { title: "Badge", message: `Badge ${prefs.badgeVisible ? "hidden" : "shown"}.`, variant: "success" });
	} else if (choice === "toggle_mode") {
		await updatePrefs((draft) => {
			draft.displayMode = draft.displayMode === "model" ? "profile" : "model";
		});
		toast(context, { title: "Badge mode", message: "Badge display mode updated.", variant: "success" });
	}
}

function SddBadge(props: { context: Context; prefs: SddPrefs; sessionID?: string }) {
	const context = props.context;
	const theme = context.theme;
	const accent = rgbaToHex(theme.text.feedback.success.base, "#00ff00");
	const muted = rgbaToHex(theme.text.muted, "#888888");
	const base = rgbaToHex(theme.text.base, "#ffffff");
	const profile = resolveBadgeProfile(context, props.sessionID);
	return (
		<Show when={props.prefs.badgeVisible}>
			<box flexDirection="row" alignItems="center" paddingLeft={1} paddingRight={1}>
				<text fg={profile ? accent : muted} attributes={profile ? 1 : 0}>
					{profile ? "󰚩 " : "󱚧 "}
				</text>
				<text fg={base}>
					{formatActiveModelBadgeText(profile, props.prefs.displayMode)}
				</text>
			</box>
		</Show>
	);
}

/** Mounted once via the `app` slot; owns the plugin keymap layer. */
function SddGlobalKeymap() {
	const context = usePlugin();
	context.keymap.layer(() => ({
		mode: "global",
		commands: [
			{
				id: "sdd-model",
				title: "SDD Profiles",
				group: "SDD",
				palette: true,
				run: () => {
					const [prefs, updatePrefs] = context.storage.store<SddPrefs>("sdd-prefs", {
						initial: initialPrefs,
					});
					void openProfilesMenu(context, prefs, updatePrefs).catch((error) => {
						log.warn("sdd-model command: profiles menu failed", error);
					});
				},
			},
		],
		bindings: ["sdd-model"],
	}));
	return null;
}

export default Plugin.define({
	id: "sdd-model-select",
	setup(context) {
		const disposers: Array<() => void> = [];
		try {
			const [prefs, updatePrefs] = context.storage.store<SddPrefs>("sdd-prefs", {
				initial: initialPrefs,
			});

			disposers.push(
				context.ui.slot({
					append: "sidebar.content",
					render: ({ sessionID }) => (
						<SddBadge context={context} prefs={prefs} sessionID={sessionID} />
					),
				}),
			);

			disposers.push(
				context.ui.slot({
					append: "home.footer.status",
					render: () => {
						// Route through context.ui.router so the footer reflects the
						// current location (session vs home).
						let sessionID: string | undefined;
						try {
							const route = context.ui.router.current();
							if (route.type === "session") sessionID = route.sessionID;
						} catch (error) {
							log.warn("home.footer.status: router read failed", error);
						}
						return <SddBadge context={context} prefs={prefs} sessionID={sessionID} />;
					},
				}),
			);

			disposers.push(
				context.ui.slot({
					append: "app",
					render: () => <SddGlobalKeymap />,
				}),
			);
		} catch (error) {
			log.warn("setup: V2 plugin init failed; OpenCode will continue without SDD UI", error);
		}

		return () => {
			for (const dispose of disposers) {
				try {
					dispose();
				} catch (error) {
					log.warn("cleanup: slot dispose failed", error);
				}
			}
		};
	},
});
