import o from "ospec"
import {OfflineDbFacade} from "../../../src/desktop/db/OfflineDbFacade"
import {OfflineStorage} from "../../../src/api/worker/rest/OfflineStorage"
import {instance, matchers, when} from "testdouble"
import {timestampToGeneratedId} from "../../../src/api/common/utils/EntityUtils"
import {verify} from "@tutao/tutanota-test-utils"
import {MailTypeRef} from "../../../src/api/entities/tutanota/Mail"
import {ContactTypeRef} from "../../../src/api/entities/tutanota/Contact"
import {getDayShifted} from "@tutao/tutanota-utils"

const {anything} = matchers

o.spec("OfflineStorage", function () {

	const userId = "userId"

	let storage: OfflineStorage
	let dbFacadeMock: OfflineDbFacade

	o.beforeEach(async function () {
		dbFacadeMock = instance(OfflineDbFacade)
		storage = new OfflineStorage(dbFacadeMock)
		await storage.init(userId, [0, 1, 2, 3, 4, 5, 6, 7])
	})

	o.spec("Clearing excluded data", function () {
		const cutoffDate = new Date("2022-01-01 00:00:00 UTC")
		const cutoffId = timestampToGeneratedId(cutoffDate.getTime())
		const mailType = MailTypeRef.type
		const contactType = ContactTypeRef.type

		const offsetId = days => timestampToGeneratedId(getDayShifted(cutoffDate, days).getTime())

		o("old data will be deleted", async function () {
			when(dbFacadeMock.getLists(userId)).thenResolve([])

			await storage.clearExcludedData({cutoffDate : cutoffDate, excludedLists : []})

			verify(dbFacadeMock.deleteEntitiesBeforeId(userId, cutoffId))
		})

		o("excluded lists will be deleted", async function () {
			when(dbFacadeMock.getLists(userId)).thenResolve([])

			await storage.clearExcludedData({cutoffDate : cutoffDate, excludedLists : [{type: mailType, listId: "list1"}, {type: contactType, listId: "list2"}]})

			verify(dbFacadeMock.deleteList(userId, mailType, "list1"))
			verify(dbFacadeMock.deleteList(userId, contactType, "list2"))
		})

		o("old ranges will be deleted", async function () {
			const listId = "listId"
			const upper = offsetId(-1)
			const lower = offsetId(-2)

			when(dbFacadeMock.getLists(userId)).thenResolve([{type: mailType, listId}])
			when(dbFacadeMock.getRange(userId, mailType, listId)).thenResolve({upper, lower})

			await storage.clearExcludedData({cutoffDate : cutoffDate, excludedLists : []})

			verify(dbFacadeMock.deleteRange(userId, mailType, listId))
		})

		o("modified ranges will be shrunk", async function () {
			const listId = "listId"
			const upper = offsetId(2)
			const lower = offsetId(-2)

			when(dbFacadeMock.getLists(userId)).thenResolve([{type: mailType, listId}])
			when(dbFacadeMock.getRange(userId, mailType, listId)).thenResolve({upper, lower})

			await storage.clearExcludedData({cutoffDate : cutoffDate, excludedLists : []})

			verify(dbFacadeMock.setLowerRange(userId, mailType, listId, cutoffId))
		})

		o("unmodified ranges will not be deleted or shrunk", async function () {
			const listId = "listId"
			const upper = offsetId(2)
			const lower = offsetId(1)

			when(dbFacadeMock.getLists(userId)).thenResolve([{type: mailType, listId}])
			when(dbFacadeMock.getRange(userId, mailType, listId)).thenResolve({upper, lower})

			await storage.clearExcludedData({cutoffDate : cutoffDate, excludedLists : []})

			verify(dbFacadeMock.setLowerRange(userId, mailType, listId, anything()), {times: 0})
			verify(dbFacadeMock.deleteRange(userId, mailType, listId), {times: 0})
		})
	})
})