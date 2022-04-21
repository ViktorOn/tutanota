import {OFFLINE_STORAGE_DEFAULT_TIME_RANGE_DAYS} from "../api/common/TutanotaConstants.js";
import {assertOfflineStorageAvailable, isOfflineStorageAvailable} from "../api/common/Env.js";
import {locator} from "../api/main/MainLocator.js";
import {logins} from "../api/main/LoginController.js";
import {OfflineDbFacade} from "../desktop/db/OfflineDbFacade.js";
import {defer} from "@tutao/tutanota-utils";
import {Dialog} from "../gui/base/Dialog.js";
import m from "mithril";
import {TextFieldN, TextFieldType} from "../gui/base/TextFieldN.js";
import stream from "mithril/stream";
import * as cborg from "cborg"

export class OfflineStorageSettingsModel {

    private _timeRange = OFFLINE_STORAGE_DEFAULT_TIME_RANGE_DAYS

    async isOfflineStorageEnabled(): Promise<boolean> {
        return isOfflineStorageAvailable() && locator.loginFacade.isPersistentSession()
    }

    /**
     * get stored time range, will error out if offlineStorage isn't available
     */
    getTimeRange(): number {
        assertOfflineStorageAvailable()
        return this._timeRange
    }

    async setTimeRange(days: number): Promise<void> {
        assertOfflineStorageAvailable()

        const encoded = cborg.encode(days)
        await this.db().putMetadata(this.userId(), "timeRangeDays", encoded)
        this._timeRange = days
    }

    async init(): Promise<void> {
        if (await this.isOfflineStorageEnabled()) {
            const stored = (await this.db().getMetadata(this.userId(), "timeRangeDays"))
            if (stored != null) {
                this._timeRange = cborg.decode(stored)
            }
        }
    }

    private userId(): Id {
        return logins.getUserController().userId
    }

    private db(): OfflineDbFacade {
        return locator.offlineDbFacade
    }
}

export async function showEditStoredDataTimeRangeDialog(settings: OfflineStorageSettingsModel) {

    const initialTimeRange = settings.getTimeRange()
    let timeRange = initialTimeRange

    const newTimeRangeDeferred = defer<number>()
    const dialog = Dialog.showActionDialog({
        title: () => "FIXME",
        child: () => m(TextFieldN, {
            label: () => "FIXME",
            type: TextFieldType.Number,
            value: stream(`${timeRange}`),
            oninput: newValue => timeRange = Number(newValue)
        }),
        okAction: async () => {
            try {
                if (initialTimeRange !== timeRange) {
                    await settings.setTimeRange(timeRange)
                }
            } finally {
                dialog.close()
            }
        },
    })

    return newTimeRangeDeferred.promise
}