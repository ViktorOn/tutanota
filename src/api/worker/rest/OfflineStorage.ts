import {TokenOrNestedTokens} from "cborg/types/interface.js"
import {ListElementEntity, SomeEntity} from "../../common/EntityTypes.js"
import {firstBiggerThanSecond, getListId, timestampToGeneratedId} from "../../common/utils/EntityUtils.js"
import {CacheStorage, expandId} from "./EntityRestCache.js"
import * as cborg from "cborg"
import {EncodeOptions, Token, Type} from "cborg"
import {assert, DAY_IN_MILLIS, mapNullable, TypeRef} from "@tutao/tutanota-utils"
import type {OfflineDbFacade} from "../../../desktop/db/OfflineDbFacade"
import {isOfflineStorageAvailable, isTest} from "../../common/Env"
import {ProgrammingError} from "../../common/error/ProgrammingError"
import {MailTypeRef} from "../../entities/tutanota/Mail"
import {MailBodyTypeRef} from "../../entities/tutanota/MailBody"
import {FileTypeRef} from "../../entities/tutanota/File"
import {MailFolderTypeRef} from "../../entities/tutanota/MailFolder"
import {MailFolderType} from "../../common/TutanotaConstants"

function dateEncoder(data: Date, typ: string, options: EncodeOptions): TokenOrNestedTokens | null {
	return [
		// https://datatracker.ietf.org/doc/rfc8943/
		new Token(Type.tag, 100),
		new Token(Type.uint, data.getTime())
	]
}

function dateDecoder(bytes: number): Date {
	return new Date(bytes)
}

export const customTypeEncoders: {[typeName: string]: typeof dateEncoder} = Object.freeze({
	"Date": dateEncoder
})

type TypeDecoder = (_: any) => any
export const customTypeDecoders: Array<TypeDecoder> = (() => {
	const tags: Array<TypeDecoder> = []
	tags[100] = dateDecoder
	return tags
})()

const DEFAULT_TIME_RANGE = 31 * DAY_IN_MILLIS

export class OfflineStorage implements CacheStorage {
	private _userId: Id | null = null

	private readonly timeLimitedTypes = [
		MailTypeRef,
		MailBodyTypeRef,
		FileTypeRef
	]

	constructor(
		private readonly offlineDbFacade: OfflineDbFacade,
	) {
		assert(isOfflineStorageAvailable() || isTest(), "Offline storage is not available.")
	}

	async init(userId: Id, databaseKey: Aes256Key): Promise<void> {
		this._userId = userId
		await this.offlineDbFacade.openDatabaseForUser(userId, databaseKey)
	}

	async close(): Promise<void> {
		await this.offlineDbFacade.closeDatabaseForUser(this.userId)
	}

	private get userId(): Id {
		if (this._userId == null) {
			throw new ProgrammingError("Offline storage not initialized")
		}

		return this._userId
	}

	async deleteIfExists(typeRef: TypeRef<SomeEntity>, listId: Id | null, id: Id): Promise<void> {
		return this.offlineDbFacade.delete(this.userId, this.getTypeId(typeRef), listId, id)
	}

	async get<T extends SomeEntity>(typeRef: TypeRef<T>, listId: Id | null, id: Id): Promise<T | null> {
		const loaded = await this.offlineDbFacade.get(this.userId, this.getTypeId(typeRef), listId, id) ?? null
		return loaded && this.deserialize(typeRef, loaded)
	}

	async getIdsInRange<T extends ListElementEntity>(typeRef: TypeRef<T>, listId: Id): Promise<Array<Id>> {
		return this.offlineDbFacade.getIdsInRange(this.userId, this.getTypeId(typeRef), listId)
	}

	async getRangeForList<T extends ListElementEntity>(typeRef: TypeRef<T>, listId: Id): Promise<{lower: Id, upper: Id} | null> {
		return this.offlineDbFacade.getRange(this.userId, this.getTypeId(typeRef), listId)
	}

	async isElementIdInCacheRange<T extends ListElementEntity>(typeRef: TypeRef<T>, listId: Id, id: Id): Promise<boolean> {
		const range = await this.getRangeForList(typeRef, listId)
		return range != null
			&& !firstBiggerThanSecond(id, range.upper)
			&& !firstBiggerThanSecond(range.lower, id)
	}

	async provideFromRange<T extends ListElementEntity>(typeRef: TypeRef<T>, listId: Id, start: Id, count: number, reverse: boolean): Promise<T[]> {
		const result = await this.offlineDbFacade.provideFromRange(this.userId, this.getTypeId(typeRef), listId, start, count, reverse)
		return result.map((str) => this.deserialize(typeRef, str))
	}

	async put(originalEntity: SomeEntity): Promise<void> {
		const serializedEntity = this.serialize(originalEntity)
		const {listId, elementId} = expandId(originalEntity._id)
		return this.offlineDbFacade.put(this.userId, {type: this.getTypeId(originalEntity._type), listId, elementId, entity: serializedEntity})
	}

	async setLowerRangeForList<T extends ListElementEntity>(typeRef: TypeRef<T>, listId: Id, id: Id): Promise<void> {
		return this.offlineDbFacade.setLowerRange(this.userId, this.getTypeId(typeRef), listId, id)
	}

	async setUpperRangeForList<T extends ListElementEntity>(typeRef: TypeRef<T>, listId: Id, id: Id): Promise<void> {
		return this.offlineDbFacade.setUpperRange(this.userId, this.getTypeId(typeRef), listId, id)
	}

	async setNewRangeForList<T extends ListElementEntity>(typeRef: TypeRef<T>, listId: Id, lower: Id, upper: Id): Promise<void> {
		return this.offlineDbFacade.setNewRange(this.userId, this.getTypeId(typeRef), listId, lower, upper)
	}

	private getTypeId(typeRef: TypeRef<unknown>) {
		return typeRef.app + "/" + typeRef.type
	}

	private serialize(originalEntity: SomeEntity): Uint8Array {
		return cborg.encode(originalEntity, {typeEncoders: customTypeEncoders})
	}

	private deserialize<T extends SomeEntity>(typeRef: TypeRef<T>, loaded: Uint8Array): T {
		const deserialized = cborg.decode(loaded, {tags: customTypeDecoders})
		// TypeRef cannot be deserialized back automatically. We could write a codec for it but we don't actually
		// need to store it so we just "patch" it.
		// Some places rely on TypeRef being a class and not a plain object.
		deserialized._type = typeRef
		return deserialized
	}

	getLastBatchIdForGroup(groupId: Id): Promise<Id | null> {
		return this.offlineDbFacade.getLastBatchIdForGroup(this.userId, groupId)
	}

	async putLastBatchIdForGroup(groupId: Id, batchId: Id): Promise<void> {
		await this.offlineDbFacade.putLastBatchIdForGroup(this.userId, groupId, batchId)
	}

	async getLastUpdateTime(): Promise<number | null> {
		return this.getMetadata("lastUpdateTime")
	}

	async putLastUpdateTime(ms: number): Promise<void> {
		await this.putMetadata("lastUpdateTime", ms)
	}

	private async putMetadata<K extends keyof OfflineDbMeta>(key: K, value: OfflineDbMeta[K]): Promise<void> {
		await this.offlineDbFacade.putMetadata(this.userId, key, cborg.encode(value))
	}

	private async getMetadata<K extends keyof OfflineDbMeta>(key: K): Promise<OfflineDbMeta[K] | null> {
		const encoded = await this.offlineDbFacade.getMetadata(this.userId, key)
		return encoded && cborg.decode(encoded)
	}

	async purgeStorage(): Promise<void> {
		await this.offlineDbFacade.deleteAll(this.userId)
	}

	async clearExcludedData(): Promise<void> {

		const cutoffTimestamp = await this.getCutoffTimestamp()

		const {trash, spam} = await this.getTrashAndSpamFolderIds()

		if (trash) {
			await this.offlineDbFacade.deleteList(this.userId, this.getTypeId(MailTypeRef), trash)
		}

		if (spam) {
			await this.offlineDbFacade.deleteList(this.userId, this.getTypeId(MailTypeRef), spam)
		}

		const cutoffId = timestampToGeneratedId(cutoffTimestamp)

		const limitedTypeIds = this.timeLimitedTypes.map(type => this.getTypeId(type))
		for (let type of limitedTypeIds) {
			// Delete all entities that were created before the cutoff
			await this.offlineDbFacade.deleteEntitiesBeforeId(this.userId, type, cutoffId)
		}

		// Update any ranges that have now been reduced due to the deletion of list entities
		// If the range was completely before the cutoff, then it gets deleted
		// If only the lower part of the range was before the cutoff, it gets set to the cutoff id
		// Otherwise it is left alone
		const lists = await this.offlineDbFacade.getLists(this.userId)
		for (let {type, listId} of lists) {

			// unlimited types were not modified
			if (!limitedTypeIds.includes(type)) {
				continue
			}

			const range = await this.offlineDbFacade.getRange(this.userId, type, listId)
			if (range == null) {
				continue
			}

			if (firstBiggerThanSecond(cutoffId, range.lower)) {
				if (firstBiggerThanSecond(cutoffId, range.upper)) {
					await this.offlineDbFacade.deleteRange(this.userId, type, listId)
				} else {
					await this.offlineDbFacade.setLowerRange(this.userId, type, listId, cutoffId)
				}
			}
		}
	}

	async getTimeRangeMs(): Promise<number> {
		return await this.getMetadata("timeRangeMs") ?? DEFAULT_TIME_RANGE
	}

	async setTimeRangeMs(rangeMs: number): Promise<void> {
		await this.putMetadata("timeRangeMs", rangeMs)
	}

	async getCutoffTimestamp(): Promise<number> {
		return Date.now() + await this.getTimeRangeMs()
	}

	/**
	 * It's annoying to get a list of mail folders at the time at which we initialise the offline storage
	 * So for now we just read them from the offline DB itself so that we can delete any entities from either list.
	 */
	private async getTrashAndSpamFolderIds(): Promise<{trash: Id | null, spam: Id | null}> {
		const folders = await this.offlineDbFacade.getAll(this.userId, this.getTypeId(MailFolderTypeRef))
								  .then(entities => entities.map(entity => this.deserialize(MailFolderTypeRef, entity)))

		const trash = mapNullable(folders.find(folder => folder.folderType === MailFolderType.TRASH), getListId) ?? null
		const spam = mapNullable(folders.find(folder => folder.folderType === MailFolderType.SPAM), getListId) ?? null

		return {trash, spam}
	}
}

export interface OfflineDbMeta {
	lastUpdateTime: number
	timeRangeMs: number
}