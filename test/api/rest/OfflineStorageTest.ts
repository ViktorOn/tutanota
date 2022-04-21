import o from "ospec"
import {OfflineDbFacade} from "../../../src/desktop/db/OfflineDbFacade"
import {OfflineStorage} from "../../../src/api/worker/rest/OfflineStorage"
import {instance, matchers, object, when} from "testdouble"
import {timestampToGeneratedId} from "../../../src/api/common/utils/EntityUtils"
import {verify} from "@tutao/tutanota-test-utils"
import {MailTypeRef} from "../../../src/api/entities/tutanota/Mail"
import {ContactTypeRef} from "../../../src/api/entities/tutanota/Contact"
import {getDayShifted} from "@tutao/tutanota-utils"
import * as cborg from "cborg"
import {DateProvider} from "../../../src/api/common/DateProvider"
import {MailFolderTypeRef} from "../../../src/api/entities/tutanota/MailFolder"

const {anything} = matchers

o.spec("OfflineStorage", function () {

	const userId = "userId"
	const now = new Date("2022-01-01 00:00:00 UTC")

	let storage: OfflineStorage
	let dbFacadeMock: OfflineDbFacade
	let dateProviderMock: DateProvider

	o.beforeEach(async function () {
		dbFacadeMock = instance(OfflineDbFacade)
		dateProviderMock = object<DateProvider>()
		when(dateProviderMock.now()).thenReturn(now.getTime())
		storage = new OfflineStorage(dbFacadeMock, dateProviderMock)
		await storage.init(userId, [0, 1, 2, 3, 4, 5, 6, 7])
	})

	o.spec("Clearing excluded data", function () {
		const timeRangeDays = 10
		const storedTimeRange = cborg.encode(timeRangeDays)
		const mailType = MailTypeRef.getId()
		const mailFolderType = MailFolderTypeRef.getId()

		/** get an id from a timestamp that is offset by some amount of days from the cutoff time */
		const offsetId = days => timestampToGeneratedId(getDayShifted(now, timeRangeDays + days).getTime())

		const cutoffId = offsetId(0)

		o("old data will be deleted", async function () {
			when(dbFacadeMock.getLists(userId)).thenResolve([])
			when(dbFacadeMock.getMetadata(userId, "timeRangeDays")).thenResolve(storedTimeRange)
			when(dbFacadeMock.getAll(userId, mailFolderType)).thenResolve([])
			await storage.clearExcludedData()

			verify(dbFacadeMock.deleteEntitiesBeforeId(userId, anything(), cutoffId))
		})

		o("old ranges will be deleted", async function () {
			const listId = "listId"
			const upper = offsetId(-1)
			const lower = offsetId(-2)

			when(dbFacadeMock.getLists(userId)).thenResolve([{type: mailType, listId}])
			when(dbFacadeMock.getRange(userId, mailType, listId)).thenResolve({upper, lower})
			when(dbFacadeMock.getMetadata(userId, "timeRangeDays")).thenResolve(storedTimeRange)
			when(dbFacadeMock.getAll(userId, mailFolderType)).thenResolve([])

			await storage.clearExcludedData()

			verify(dbFacadeMock.deleteRange(userId, mailType, listId))
		})

		o("modified ranges will be shrunk", async function () {
			const listId = "listId"
			const upper = offsetId(2)
			const lower = offsetId(-2)

			when(dbFacadeMock.getLists(userId)).thenResolve([{type: mailType, listId}])
			when(dbFacadeMock.getRange(userId, mailType, listId)).thenResolve({upper, lower})
			when(dbFacadeMock.getMetadata(userId, "timeRangeDays")).thenResolve(storedTimeRange)
			when(dbFacadeMock.getAll(userId, mailFolderType)).thenResolve([])

			await storage.clearExcludedData()

			verify(dbFacadeMock.setLowerRange(userId, mailType, listId, cutoffId))
		})

		o("unmodified ranges will not be deleted or shrunk", async function () {
			const listId = "listId"
			const upper = offsetId(2)
			const lower = offsetId(1)

			when(dbFacadeMock.getLists(userId)).thenResolve([{type: mailType, listId}])
			when(dbFacadeMock.getRange(userId, mailType, listId)).thenResolve({upper, lower})
			when(dbFacadeMock.getMetadata(userId, "timeRangeDays")).thenResolve(storedTimeRange)
			when(dbFacadeMock.getAll(userId, mailFolderType)).thenResolve([])

			await storage.clearExcludedData()

			verify(dbFacadeMock.setLowerRange(userId, mailType, listId, anything()), {times: 0})
			verify(dbFacadeMock.deleteRange(userId, mailType, listId), {times: 0})
		})
	})
})