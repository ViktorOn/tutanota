import {
	AccessBlockedError,
	AccessDeactivatedError,
	AccessExpiredError,
	ConnectionError,
	InsufficientStorageError,
	InvalidSoftwareVersionError,
	NotAuthenticatedError,
	ServiceUnavailableError,
	SessionExpiredError,
} from "../api/common/error/RestError"
import {Dialog} from "../gui/base/Dialog"
import {lang} from "./LanguageViewModel"
import {assertMainOrNode} from "../api/common/Env"
import {neverNull, noOp} from "@tutao/tutanota-utils"
import {logins} from "../api/main/LoginController"
import {OutOfSyncError} from "../api/common/error/OutOfSyncError"
import {showProgressDialog} from "../gui/dialogs/ProgressDialog"
import {IndexingNotSupportedError} from "../api/common/error/IndexingNotSupportedError"
import {windowFacade} from "./WindowFacade"
import {locator} from "../api/main/MainLocator"
import {QuotaExceededError} from "../api/common/error/QuotaExceededError"
import {UserError} from "../api/main/UserError"
import {showMoreStorageNeededOrderDialog} from "./SubscriptionDialogs"
import {showSnackBar} from "../gui/base/SnackBar"
import {Credentials} from "./credentials/Credentials"
import {promptForFeedbackAndSend, showErrorDialogNotLoggedIn} from "./ErrorReporter"

assertMainOrNode()

let unknownErrorDialogActive = false
let notConnectedDialogActive = false
let invalidSoftwareVersionActive = false
let loginDialogActive = false
let isLoggingOut = false
let serviceUnavailableDialogActive = false
let shownQuotaError = false
let showingImportError = false
const ignoredMessages = ["webkitExitFullScreen", "googletag", "avast_submit"]

export function handleUncaughtErrorImpl(e: Error) {
	if (isLoggingOut) {
		// ignore all errors while logging out
		return
	}

	// This is from the s.js and it shouldn't change. Unfortunately it is a plain Error.
	if (e.message.includes("(SystemJS https://git.io/JvFET#")) {
		handleImportError()
		return
	}

	if (e instanceof ConnectionError) {
		showOfflineMessage()
	} else if (e instanceof InvalidSoftwareVersionError) {
		if (!invalidSoftwareVersionActive) {
			invalidSoftwareVersionActive = true
			Dialog.message("outdatedClient_msg").then(() => (invalidSoftwareVersionActive = false))
		}
	} else if (
		e instanceof NotAuthenticatedError ||
		e instanceof AccessBlockedError ||
		e instanceof AccessDeactivatedError ||
		e instanceof AccessExpiredError
	) {
		// If we session is closed (e.g. password is changed) we log user out forcefully so we reload the page
		logoutIfNoPasswordPrompt()
	} else if (e instanceof SessionExpiredError) {
		reloginForExpiredSession()
	} else if (e instanceof OutOfSyncError) {
		Dialog.message("dataExpired_msg")
	} else if (e instanceof InsufficientStorageError) {
		if (logins.getUserController().isGlobalAdmin()) {
			showMoreStorageNeededOrderDialog(logins, "insufficientStorageAdmin_msg")
		} else {
			const errorMessage = () => lang.get("insufficientStorageUser_msg") + " " + lang.get("contactAdmin_msg")

			Dialog.message(errorMessage)
		}
	} else if (e instanceof ServiceUnavailableError) {
		if (!serviceUnavailableDialogActive) {
			serviceUnavailableDialogActive = true
			Dialog.message("serviceUnavailable_msg").then(() => {
				serviceUnavailableDialogActive = false
			})
		}
	} else if (e instanceof IndexingNotSupportedError) {
		console.log("Indexing not supported", e)
		locator.search.indexingSupported = false
	} else if (e instanceof QuotaExceededError) {
		if (!shownQuotaError) {
			shownQuotaError = true
			Dialog.message("storageQuotaExceeded_msg")
		}
	} else if (ignoredError(e)) {
		// ignore, this is not our code
	} else {
		if (!unknownErrorDialogActive) {
			unknownErrorDialogActive = true

			// only logged in users can report errors
			if (logins.isUserLoggedIn()) {
				promptForFeedbackAndSend(e)
					.then(({ignored}) => {
						unknownErrorDialogActive = false
						if (ignored) {
							ignoredMessages.push(e.message)
						}
					})
			} else {
				console.log("Unknown error", e)
				showErrorDialogNotLoggedIn(e)
					.then(() => unknownErrorDialogActive = false)
			}
		}
	}
}

function showOfflineMessage() {
	if (!notConnectedDialogActive) {
		notConnectedDialogActive = true
		showSnackBar({
			message: "serverNotReachable_msg",
			button: {
				label: "ok_action",
				click: () => {
				}
			},
			onClose: () => {
				notConnectedDialogActive = false
			}
		})
	}
}

function logoutIfNoPasswordPrompt() {
	if (!loginDialogActive) {
		windowFacade.reload({})
	}
}

export async function reloginForExpiredSession() {
	if (!loginDialogActive) {
		// Make sure that partial login part is complete before we will try to make a new session.
		// Otherwise we run into a race condition where login failure arrives before we initialize userController.
		await logins.waitForUserLogin()
		console.log("RELOGIN", logins.isUserLoggedIn())
		const sessionType = logins.getUserController().sessionType
		const userId = logins.getUserController().user._id
		locator.loginFacade.resetSession()
		loginDialogActive = true

		const dialog = Dialog.showRequestPasswordDialog({
			action: async (pw) => {
				let credentials: Credentials
				try {
					credentials = await showProgressDialog(
						"pleaseWait_msg",
						logins.createSession(neverNull(logins.getUserController().userGroupInfo.mailAddress), pw, sessionType),
					)
				} catch (e) {
					if (e in AccessBlockedError) {
						return lang.get("loginFailedOften_msg")
					} else if (e instanceof NotAuthenticatedError) {
						return lang.get("loginFailed_msg")
					} else if (e instanceof AccessDeactivatedError) {
						return lang.get("loginFailed_msg")
					} else if (e instanceof ConnectionError) {
						return lang.get("serverNotReachable_msg")
					} else {
						throw e
					}
				} finally {
					// Once login succeeds we need to manually close the dialog
					locator.secondFactorHandler.closeWaitingForSecondFactorDialog()
				}
				// Fetch old credentials to preserve database key if it's there
				const oldCredentials = await locator.credentialsProvider.getCredentialsByUserId(userId)
				await locator.credentialsProvider.deleteByUserId(userId, {offlineDb: "keep"})
				await locator.credentialsProvider.store({credentials: credentials, databaseKey: oldCredentials?.databaseKey})
				loginDialogActive = false
				dialog.close()
				return ""
			},
			cancel: {
				textId: "logout_label",
				action() {
					windowFacade.reload({})
				},
			}
		})
	}
}

function ignoredError(e: Error): boolean {
	return e.message != null && ignoredMessages.some(s => e.message.includes(s))
}

/**
 * Trying to handle errors during logout can cause unhandled error loops, so we just want to ignore them
 */
export function disableErrorHandlingDuringLogout() {
	isLoggingOut = true
	showProgressDialog("loggingOut_msg", new Promise(noOp))
}

function handleImportError() {
	if (showingImportError) {
		return
	}

	showingImportError = true
	const message =
		"There was an error while loading part of the app. It might be that you are offline, running an outdated version, or your browser is blocking the request."
	Dialog.choice(() => message, [
		{
			text: "close_alt",
			value: false,
		},
		{
			text: "reloadPage_action",
			value: true,
		},
	]).then(reload => {
		showingImportError = false

		if (reload) {
			windowFacade.reload({})
		}
	})
}

if (typeof window !== "undefined") {
	// @ts-ignore
	window.tutao.testError = () => handleUncaughtErrorImpl(new Error("test error!"))
}

export function showUserError(error: UserError): Promise<void> {
	return Dialog.message(() => error.message)
}