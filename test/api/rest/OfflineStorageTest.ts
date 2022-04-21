import o from "ospec"
import {OfflineDbFacade} from "../../../src/desktop/db/OfflineDbFacade"
import {OfflineStorage} from "../../../src/api/worker/rest/OfflineStorage"
import {instance, matchers, object, when} from "testdouble"
import {generatedIdToTimestamp, timestampToGeneratedId} from "../../../src/api/common/utils/EntityUtils"
import {verify} from "@tutao/tutanota-test-utils"
import {createMail, Mail, MailTypeRef} from "../../../src/api/entities/tutanota/Mail"
import {DAY_IN_MILLIS, getDayShifted} from "@tutao/tutanota-utils"
import * as cborg from "cborg"
import {DateProvider} from "../../../src/api/common/DateProvider"
import {createMailFolder, MailFolderTypeRef} from "../../../src/api/entities/tutanota/MailFolder"
import {MailFolderType} from "../../../src/api/common/TutanotaConstants"
import {OfflineDb} from "../../../src/desktop/db/OfflineDb"
import {aes256RandomKey} from "@tutao/tutanota-crypto"
import {createMailBody, MailBody} from "../../../src/api/entities/tutanota/MailBody"
import {expandId} from "../../../src/api/worker/rest/EntityRestCache"

const {anything} = matchers

function incrementId(id: Id, ms: number) {
	const timestamp = generatedIdToTimestamp(id)
	return timestampToGeneratedId(timestamp + ms)
}

class IdGenerator {
	constructor(
		private currentId: Id
	) {
	}

	getNext(incrementByMs: number = 1000): Id {
		this.currentId = incrementId(this.currentId, incrementByMs)
		return this.currentId
	}
}

o.spec("OfflineStorage", function () {
	const now = new Date("2022-01-01 00:00:00 UTC")
	const timeRangeDays = 10
	const userId = "userId"

	/** get an id from a timestamp that is offset by some amount of days from the cutoff time */
	const offsetId = days => timestampToGeneratedId(getDayShifted(now, timeRangeDays + days).getTime())
	const cutoffId = offsetId(0)


	o.spec("Unit test", function () {

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
			const storedTimeRange = cborg.encode(timeRangeDays)
			const mailType = MailTypeRef.getId()
			const mailFolderType = MailFolderTypeRef.getId()

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

			o("trash and spam is cleared", async function () {
				const spamListId = "spamList"
				const trashListId = "trashList"
				when(dbFacadeMock.getLists(userId)).thenResolve([])
				when(dbFacadeMock.getMetadata(userId, "timeRangeDays")).thenResolve(storedTimeRange)
				when(dbFacadeMock.getAll(userId, mailFolderType)).thenResolve([
					cborg.encode(createMailFolder({mails: spamListId, folderType: MailFolderType.SPAM})),
					cborg.encode(createMailFolder({mails: trashListId, folderType: MailFolderType.TRASH})),
				])

				await storage.clearExcludedData()

				verify(dbFacadeMock.deleteList(userId, mailType, spamListId))
				verify(dbFacadeMock.deleteList(userId, mailType, trashListId))
			})
		})
	})

	o.spec("Integration test", function () {


		let offlineStorage: OfflineStorage

		o.beforeEach(async function () {

			const offlineDbFacade = new OfflineDbFacade(async (userId, key) => {
				const db = new OfflineDb(globalThis.buildOptions.sqliteNativePath)
				await db.init(":memory:", key, false)
				return db
			})

			const dateProvider = {
				now: () => now.getTime(),
				timeZone: () => {
					throw new Error()
				}
			}

			offlineStorage = new OfflineStorage(offlineDbFacade, dateProvider)

			await offlineStorage.init(userId, aes256RandomKey())
		})

		function createMailList(
			numMails,
			listId,
			idGenerator,
			getSubject,
			getBody
		): {
			mails: Array<Mail>,
			mailBodies: Array<MailBody>
		} {

			const mails: Array<Mail> = []
			const mailBodies: Array<MailBody> = []
			for (let i = 0; i < numMails; ++i) {
				const mailId = idGenerator.getNext()
				const bodyId = idGenerator.getNext()
				mails.push(createMail({
					_id: [listId, mailId],
					subject: getSubject(i),
					body: bodyId
				}))
				mailBodies.push(createMailBody({
					_id: bodyId,
					text: getBody(i)
				}))
			}
			return {mails, mailBodies}
		}

		o.only("cleanup works as expected", async function () {

			const oldIds = new IdGenerator(incrementId(cutoffId, -10 * DAY_IN_MILLIS))
			const newIds = new IdGenerator(incrementId(cutoffId, 10 * DAY_IN_MILLIS))

			const inboxListId = oldIds.getNext()
			const inboxFolder = createMailFolder({
				_id: [userId, oldIds.getNext()],
				mails: inboxListId
			})
			const {
				mails: oldInboxMails,
				mailBodies: oldInboxMailBodies
			} = createMailList(3, inboxListId, oldIds, i => `old subject ${i}`, i => `old body ${i}`)
			const {
				mails: newInboxMails,
				mailBodies: newInboxMailBodies
			} = createMailList(3, inboxListId, newIds, i => `new subject ${i}`, i => `new body ${i}`)


			const trashListId = oldIds.getNext()
			const trashFolder = createMailFolder({
				_id: [userId, oldIds.getNext()],
				mails: trashListId
			})
			const {
				mails: trashMails,
				mailBodies: trashMailBodies
			} = createMailList(3, inboxListId, newIds, i => `trash subject ${i}`, i => `trash body ${i}`)

			const everyEntity = [
				inboxFolder, trashFolder,
				...oldInboxMails, ...oldInboxMailBodies,
				...newInboxMails, ...newInboxMailBodies,
				...trashMails, ...trashMailBodies
			]

			for (let entity of everyEntity) {
				await offlineStorage.put(entity)
			}

			await offlineStorage.clearExcludedData()

			const assertContents = async ({_id, _type}, expected, msg) => {
				const {listId, elementId} = expandId(_id)
				return o(await offlineStorage.get(_type, listId, elementId)).deepEquals(expected)(msg)
			}

			oldInboxMails.forEach(mail => assertContents(mail, null, `mail ${mail._id} was deleted`))
			oldInboxMailBodies.forEach(body => assertContents(body, null, `mailBody ${body._id} was deleted`))

			newInboxMails.forEach(mail => assertContents(mail, mail, `mail ${mail._id} was not deleted`))
			newInboxMailBodies.forEach(body => assertContents(body, body, `mailBody ${body._id} was not deleted`))

			// All of trash should be cleared, even though the ids are old
			trashMails.forEach(mail => assertContents(mail, null, `mail ${mail._id} was deleted`))
			trashMailBodies.forEach(body => assertContents(body, null, `mailBody ${body._id} was deleted`))

			assertContents(inboxFolder, inboxFolder, `inbox folder was not deleted`)
			assertContents(trashFolder, trashFolder, `trash folder was not deleted`)

		})
	})
})