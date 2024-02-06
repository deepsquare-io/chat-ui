import { base } from "$app/paths";
import { env } from "$env/dynamic/private";
import { env as publicEnv } from "$env/dynamic/public";
import { findUser, refreshSessionCookie, requiresUser } from "$lib/server/auth";
import { collections } from "$lib/server/database";
import { ERROR_MESSAGES } from "$lib/stores/errors";
import { sha256 } from "$lib/utils/sha256";
import type { Handle } from "@sveltejs/kit";
import { addWeeks } from "date-fns";

export const handle: Handle = async ({ event, resolve }) => {
	if (event.url.pathname.startsWith(`${base}/api/`) && env.EXPOSE_API !== "true") {
		return new Response("API is disabled", { status: 403 });
	}

	function errorResponse(status: number, message: string) {
		const sendJson =
			event.request.headers.get("accept")?.includes("application/json") ||
			event.request.headers.get("content-type")?.includes("application/json");
		return new Response(sendJson ? JSON.stringify({ error: message }) : message, {
			status,
			headers: {
				"content-type": sendJson ? "application/json" : "text/plain",
			},
		});
	}

	const token = event.cookies.get(env.COOKIE_NAME);

	let secretSessionId: string;
	let sessionId: string;

	if (token) {
		secretSessionId = token;
		sessionId = await sha256(token);

		const user = await findUser(sessionId);

		if (user) {
			event.locals.user = user;
		}
	} else {
		// if the user doesn't have any cookie, we generate one for him
		secretSessionId = crypto.randomUUID();
		sessionId = await sha256(secretSessionId);

		if (await collections.sessions.findOne({ sessionId })) {
			return errorResponse(500, "Session ID collision");
		}
	}

	event.locals.sessionId = sessionId;

	// CSRF protection
	const requestContentType = event.request.headers.get("content-type")?.split(";")[0] ?? "";
	/** https://developer.mozilla.org/en-US/docs/Web/HTML/Element/form#attr-enctype */
	const nativeFormContentTypes = [
		"multipart/form-data",
		"application/x-www-form-urlencoded",
		"text/plain",
	];

	if (event.request.method === "POST") {
		refreshSessionCookie(event.cookies, event.locals.sessionId);

		if (nativeFormContentTypes.includes(requestContentType)) {
			const referer = event.request.headers.get("referer");

			if (!referer) {
				return errorResponse(403, "Non-JSON form requests need to have a referer");
			}

			const validOrigins = [
				new URL(event.request.url).origin,
				...(publicEnv.PUBLIC_ORIGIN ? [new URL(publicEnv.PUBLIC_ORIGIN).origin] : []),
			];

			if (!validOrigins.includes(new URL(referer).origin)) {
				return errorResponse(403, "Invalid referer for POST request");
			}
		}
	}

	if (event.request.method === "POST") {
		// if the request is a POST request we refresh the cookie
		refreshSessionCookie(event.cookies, secretSessionId);

		await collections.sessions.updateOne(
			{ sessionId },
			{ $set: { updatedAt: new Date(), expiresAt: addWeeks(new Date(), 2) } }
		);
	}

	if (
		!event.url.pathname.startsWith(`${base}/login`) &&
		!event.url.pathname.startsWith(`${base}/admin`) &&
		!["GET", "OPTIONS", "HEAD"].includes(event.request.method)
	) {
		if (
			!event.locals.user &&
			requiresUser &&
			!((env.MESSAGES_BEFORE_LOGIN ? parseInt(env.MESSAGES_BEFORE_LOGIN) : 0) > 0)
		) {
			return errorResponse(401, ERROR_MESSAGES.authOnly);
		}

		// if login is not required and the call is not from /settings and we display the ethics modal with PUBLIC_APP_DISCLAIMER
		//  we check if the user has accepted the ethics modal first.
		// If login is required, `ethicsModalAcceptedAt` is already true at this point, so do not pass this condition. This saves a DB call.
		if (
			!requiresUser &&
			!event.url.pathname.startsWith(`${base}/settings`) &&
			!!publicEnv.PUBLIC_APP_DISCLAIMER
		) {
			const hasAcceptedEthicsModal = await collections.settings.countDocuments({
				sessionId: event.locals.sessionId,
				ethicsModalAcceptedAt: { $exists: true },
			});

			if (!hasAcceptedEthicsModal) {
				return errorResponse(405, "You need to accept the welcome modal first");
			}
		}
	}

	let replaced = false;

	const response = await resolve(event, {
		transformPageChunk: (chunk) => {
			// For some reason, Sveltekit doesn't let us load env variables from .env in the app.html template
			if (replaced || !chunk.html.includes("%gaId%")) {
				return chunk.html;
			}
			replaced = true;

			return chunk.html.replace("%gaId%", publicEnv.PUBLIC_GOOGLE_ANALYTICS_ID);
		},
	});

	return response;
};
