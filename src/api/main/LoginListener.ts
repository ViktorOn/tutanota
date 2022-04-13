import {Challenge} from "../entities/sys/Challenge.js"
import {SecondFactorHandler} from "../../misc/2fa/SecondFactorHandler.js"
import {LoginController} from "./LoginController.js"

/** Listener for the login events from the worker side. */
export interface ILoginListener {
	/**
	 * Partial login reached: cached entities and user are avabilable.
	 */
	onPartialLoginSuccess(): Promise<void>

	/**
	 * Full login reached: any network requests can be made
	 */
	onFullLoginSuccess(): Promise<void>

	onLoginError(): Promise<void>

	/**
	 * Shows a dialog with possibility to use second factor and with a message that the login can be approved from another client.
	 */
	onSecondFactorChallenge(sessionId: IdTuple, challenges: ReadonlyArray<Challenge>, mailAddress: string | null): Promise<void>
}

export class LoginListener implements ILoginListener {

	constructor(
		private readonly secondFactorHandler: SecondFactorHandler,
		private readonly loginController: LoginController,
	) {
	}

	onPartialLoginSuccess(): Promise<void> {
		return Promise.resolve()
	}

	async onFullLoginSuccess(): Promise<void> {
		return this.loginController.setFullyLoggedIn()
	}

	onLoginError(): Promise<void> {
		return Promise.resolve()
	}

	onSecondFactorChallenge(sessionId: IdTuple, challenges: ReadonlyArray<Challenge>, mailAddress: string | null): Promise<void> {
		return this.secondFactorHandler.showSecondFactorAuthenticationDialog(sessionId, challenges, mailAddress)
	}
}