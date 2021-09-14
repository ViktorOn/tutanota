// @flow
import type {FileDataDataGet} from "../../entities/tutanota/FileDataDataGet"
import {_TypeModel as FileDataDataGetTypeModel, createFileDataDataGet} from "../../entities/tutanota/FileDataDataGet"
import {addParamsToUrl, isSuspensionResponse, RestClient} from "../rest/RestClient"
import {encryptAndMapToLiteral, encryptBytes, resolveSessionKey} from "../crypto/CryptoFacade"
import type {File as TutanotaFile} from "../../entities/tutanota/File"
import {_TypeModel as FileTypeModel} from "../../entities/tutanota/File"
import {_TypeModel as FileDataTypeModel, FileDataTypeRef} from "../../entities/tutanota/FileData"
import {
	arrayEquals,
	assertNotNull,
	concat,
	filterInt,
	isEmpty,
	neverNull,
	promiseMap,
	splitUint8ArrayInChunks,
	TypeRef,
	uint8ArrayToBase64
} from "@tutao/tutanota-utils"
import {LoginFacadeImpl} from "./LoginFacade"
import {createFileDataDataPost} from "../../entities/tutanota/FileDataDataPost"
import {FileDataReturnPostTypeRef} from "../../entities/tutanota/FileDataReturnPost"
import {GroupType, MAX_BLOB_SIZE_BYTES} from "../../common/TutanotaConstants"
import {_TypeModel as FileDataDataReturnTypeModel} from "../../entities/tutanota/FileDataDataReturn"
import {HttpMethod, MediaType, resolveTypeReference} from "../../common/EntityFunctions"
import {assertWorkerOrNode, getHttpOrigin, isApp, isDesktop} from "../../common/Env"
import {handleRestError} from "../../common/error/RestError"
import {convertToDataFile} from "../../common/DataFile"
import type {SuspensionHandler} from "../SuspensionHandler"
import {StorageService} from "../../entities/storage/Services"
import type {BlobId} from "../../entities/sys/BlobId"
import {serviceRequest, serviceRequestVoid} from "../EntityWorker"
import {createBlobAccessTokenData} from "../../entities/storage/BlobAccessTokenData"
import {BlobAccessTokenReturnTypeRef} from "../../entities/storage/BlobAccessTokenReturn"
import type {BlobAccessInfo} from "../../entities/sys/BlobAccessInfo"
import {_TypeModel as BlobDataGetTypeModel, createBlobDataGet} from "../../entities/storage/BlobDataGet"
import {createBlobWriteData} from "../../entities/storage/BlobWriteData"
import {createTypeInfo} from "../../entities/sys/TypeInfo"
import type {TypeModel} from "../../common/EntityTypes"
import {aes128Decrypt, random, sha256Hash, uint8ArrayToKey} from "@tutao/tutanota-crypto"
import type {DownloadTaskResponse, NativeFileApp} from "../../../native/common/FileApp"
import type {AesApp} from "../../../native/worker/AesApp"
import type {TargetServer} from "../../entities/sys/TargetServer"
import {locator} from "../WorkerLocator"
import {ProgrammingError} from "../../common/error/ProgrammingError"
import {TutanotaService} from "../../entities/tutanota/Services"
import type {FileBlobServiceGetReturn} from "../../entities/tutanota/FileBlobServiceGetReturn"
import {FileBlobServiceGetReturnTypeRef} from "../../entities/tutanota/FileBlobServiceGetReturn"
import {FileBlobServicePostReturnTypeRef} from "../../entities/tutanota/FileBlobServicePostReturn"
import {createBlobReferenceDataPut} from "../../entities/storage/BlobReferenceDataPut"
import {getRestPath} from "../../entities/ServiceUtils"

assertWorkerOrNode()

const REST_PATH = "/rest/tutanota/filedataservice"
const STORAGE_REST_PATH = `/rest/storage/${StorageService.BlobService}`

type BlobDownloader<T> = (blobId: BlobId, headers: Params, body: string, server: TargetServer) => Promise<T>

export class FileFacade {
	_login: LoginFacadeImpl;
	_restClient: RestClient;
	_suspensionHandler: SuspensionHandler;
	_fileApp: NativeFileApp
	_aesApp: AesApp

	constructor(login: LoginFacadeImpl, restClient: RestClient, suspensionHandler: SuspensionHandler, fileApp: NativeFileApp, aesApp: AesApp) {
		this._login = login
		this._restClient = restClient
		this._suspensionHandler = suspensionHandler
		this._fileApp = fileApp
		this._aesApp = aesApp
	}

	clearFileData(): Promise<void> {
		return this._fileApp.clearFileData()
	}

	/**
	 * Download and decrypt a single blob.
	 */
	async downloadBlob(archiveId: Id, blobId: BlobId, key: Uint8Array): Promise<Uint8Array> {
		const {storageAccessToken, servers} = await this._getDownloadToken(archiveId)
		const data = await this._downloadRawBlob(storageAccessToken, archiveId, blobId, servers, this._blobDownloaderWeb.bind(this))
		return aes128Decrypt(uint8ArrayToKey(key), data)
	}

	/**
	 * Download a file and return the data itself.
	 */
	async downloadFileContent(file: TutanotaFile): Promise<DataFile> {
		const blockDownloader = (file) => this._downloadFileDataBlock(file)
		const blobDownloader = (file) => this._downloadFileDataBlob(file)
		const data = await this._downloadFileWithDownloader(file, blockDownloader, blobDownloader)

		const sessionKey = await resolveSessionKey(FileTypeModel, file)
		return convertToDataFile(file, aes128Decrypt(neverNull(sessionKey), data))
	}

	/**
	 * Download with native downloader and return only a FileReference. Useful when we don't want to pass all the data through the native bridge.
	 */
	async downloadFileContentNative(file: TutanotaFile): Promise<FileReference> {
		const blockDownloader = (file) => this._downloadFileNative(file, file => this._downloadFileDataBlockNative(file))
		const blobDownloader = (file) => this._downloadFileNative(file, file => this._downloadFileDataBlobNative(file));
		return this._downloadFileWithDownloader(file, blockDownloader, blobDownloader)
	}

	/**
	 * Download a TutanotaFile to either a FileReference (on native) or a DataFile
	 * Takes two functions that do the actual download depending on whether this TutanotaFile is saved as blobs (new BlobStorage) or blocks (old Database)
	 */
	async _downloadFileWithDownloader<T>(file: TutanotaFile, blockDownloader: (TutanotaFile) => Promise<T>, blobDownloader: (TutanotaFile) => Promise<T>): Promise<T> {
		const fileDataId = assertNotNull(file.data, "trying to download a TutanotaFile that has no data")
		const fileData = await locator.cachingEntityClient.load(FileDataTypeRef, fileDataId)

		if (!isEmpty(fileData.blocks)) {
			return blockDownloader(file)
		} else if (!isEmpty(fileData.blobs)) {
			return blobDownloader(file);
		} else {
			throw new ProgrammingError("FileData without blobs or blocks")
		}
	}

	/**
	 * Download the data for a TutanotaFile from Blocks (in Database)
	 * @return Uint8Array actual file data
	 */
	async _downloadFileDataBlock(file: TutanotaFile): Promise<Uint8Array> {
		const entityToSend = await encryptAndMapToLiteral(FileDataDataGetTypeModel, this._getFileRequestData(file), null)
		const body = JSON.stringify(entityToSend)
		const headers = this._login.createAuthHeaders()

		headers['v'] = FileDataDataGetTypeModel.version
		return this._restClient.request(REST_PATH, HttpMethod.GET, {}, headers, body, MediaType.Binary)
	}

	/**
	 * Download the data for a TutanotaFile from Blocks (in Database) on native
	 * @return NativeDownloadResult which contains a uri that points to the downloaded and decrypted file
	 */
	async _downloadFileDataBlockNative(file: TutanotaFile): Promise<DownloadTaskResponse> {
		const entityToSend = await encryptAndMapToLiteral(FileDataDataGetTypeModel, this._getFileRequestData(file), null)
		const body = JSON.stringify(entityToSend)
		let headers = this._login.createAuthHeaders()

		headers['v'] = BlobDataGetTypeModel.version
		let queryParams = {'_body': body}
		let url = addParamsToUrl(new URL(getHttpOrigin() + REST_PATH), queryParams)
		return this._fileApp.download(url.toString(), headers, file.name)
	}

	/**
	 * Downloads the data for a TutanotaFile from the BlobStorage
	 * @param file
	 * @returns {Promise<Uint8Array>} A Promise to the actual encrypted data
	 * @private
	 */
	async _downloadFileDataBlob(file: TutanotaFile): Promise<Uint8Array> {
		const blobs: Array<Uint8Array> = await this._downloadBlobsOfFile(
			file,
			(blobId: BlobId, headers: Params, body: string, server: TargetServer) =>
				this._blobDownloaderWeb(blobId, headers, body, server)
		)
		return concat(...blobs)
	}

	/**
	 * Downloads the data of a TutanotaFile from blobs using native routines
	 * @param file
	 * @returns {Promise<NativeDownloadResult>} A promise containing the result of the download and a uri pointing to the actual encrypted file in the filesystem
	 * @private
	 */
	async _downloadFileDataBlobNative(file: TutanotaFile): Promise<DownloadTaskResponse> {
		const blobs: Array<DownloadTaskResponse> = await this._downloadBlobsOfFile(
			file,
			(blobId: BlobId, headers: Params, body: string, server: TargetServer) =>
				this._blobDownloaderNative(blobId, headers, body, server)
		)

		// make sure all suspensions have been handled

		// Return first error code
		const firstError = blobs.find(result => result.statusCode !== 200)
		if (firstError) {
			return firstError
		}

		// now blobs has the correct order of downloaded blobs, and we need to tell native to join them
		const files = blobs.map(r => assertNotNull(r.encryptedFileUri))

		const encryptedFileUri = await this._fileApp.joinFiles(file.name, files)
		for (const tmpBlobFile of files) {
			this._fileApp.deleteFile(tmpBlobFile)
		}

		return {
			statusCode: 200,
			errorId: null,
			precondition: null,
			suspensionTime: null,
			encryptedFileUri
		}
	}

	async _downloadBlobsOfFile<T>(file: TutanotaFile, downloader: BlobDownloader<T>): Promise<Array<T>> {
		const serviceReturn: FileBlobServiceGetReturn = await serviceRequest(
			TutanotaService.FileBlobService,
			HttpMethod.GET,
			this._getFileRequestData(file),
			FileBlobServiceGetReturnTypeRef
		)

		const accessInfos = serviceReturn.accessInfos
		const orderedBlobInfos: Array<{blobId: BlobId, accessInfo: BlobAccessInfo}> = serviceReturn.blobs.map(blobId => {
				const accessInfo = assertNotNull(
					accessInfos.find(info => info.blobs.find(b => arrayEquals(b.blobId, blobId.blobId))),
					"Missing accessInfo for blob"
				)
				return {blobId, accessInfo}
			}
		)

		return promiseMap(orderedBlobInfos, ({blobId, accessInfo}) => {
			return this._downloadRawBlob(accessInfo.storageAccessToken, accessInfo.archiveId, blobId, accessInfo.servers, downloader)
		}, {concurrency: 1})
	}

	/**
	 * Downloads the data of a TutanotaFile with a supplied downloader function (for blobs or blocks)
	 * Takes care of suspension handling and decryption of the data
	 * @param fileDownloader Function used to download the encrypted file contents to the filesystem (from either blobs or blocks)
	 * @returns {Promise<FileReference>} A promise containing a uri pointing to the decrypted file in the filesystem
	 * @private
	 */
	async _downloadFileNative(file: TutanotaFile, fileDownloader: (TutanotaFile) => Promise<DownloadTaskResponse>): Promise<FileReference> {
		if (!isApp() && !isDesktop()) {
			return Promise.reject("Environment is not app or Desktop!")
		}

		if (this._suspensionHandler.isSuspended()) {
			return this._suspensionHandler.deferRequest(() => this._downloadFileNative(file, fileDownloader))
		}

		const sessionKey = await resolveSessionKey(FileTypeModel, file)
		const {
			statusCode,
			encryptedFileUri,
			errorId,
			precondition,
			suspensionTime
		} = await fileDownloader(file)


		try {
			if (statusCode === 200 && encryptedFileUri != null) {
				const decryptedFileUrl = await this._aesApp.aesDecryptFile(neverNull(sessionKey), encryptedFileUri)

				const mimeType = file.mimeType == null ? MediaType.Binary : file.mimeType
				return {
					_type: 'FileReference',
					name: file.name,
					mimeType,
					location: decryptedFileUrl,
					size: filterInt(file.size)
				}

			} else if (isSuspensionResponse(statusCode, suspensionTime)) {
				this._suspensionHandler.activateSuspensionIfInactive(Number(suspensionTime))
				return this._suspensionHandler.deferRequest(() => this._downloadFileNative(file, fileDownloader))
			} else {
				throw handleRestError(statusCode, ` | GET failed to natively download attachment`, errorId, precondition)
			}
		} catch {
			if (encryptedFileUri != null) {
				try {
					await this._fileApp.deleteFile(encryptedFileUri)
				} catch {
					console.log("Failed to delete encrypted file", encryptedFileUri)
				}
			}
			// TODO better error handling here
			throw new Error("Failed to download file")
		}
	}

	_getFileRequestData(file: TutanotaFile): FileDataDataGet {
		let requestData = createFileDataDataGet()
		requestData.file = file._id
		requestData.base64 = false
		return requestData
	}

	async _downloadRawBlob<T>(storageAccessToken: string, archiveId: Id, blobId: BlobId, servers: Array<TargetServer>, blobDownloader: BlobDownloader<T>): Promise<T> {
		const headers = Object.assign({
			storageAccessToken,
			'v': BlobDataGetTypeModel.version
		}, this._login.createAuthHeaders())
		const getData = createBlobDataGet({
			archiveId,
			blobId
		})
		const literalGetData = await encryptAndMapToLiteral(BlobDataGetTypeModel, getData, null)
		const body = JSON.stringify(literalGetData)
		const server = servers[0] // TODO: Use another server if download fails

		return blobDownloader(blobId, headers, body, server)
	}

	async _blobDownloaderWeb(blobId: BlobId, headers: Params, body: string, server: TargetServer): Promise<Uint8Array> {
		return this._restClient.request(getRestPath(StorageService.BlobService), HttpMethod.GET, {},
			headers, body, MediaType.Binary, null, server.url)
	}

	async _blobDownloaderNative(blobId: BlobId, headers: Params, body: string, server: TargetServer): Promise<DownloadTaskResponse> {
		const filename = uint8ArrayToBase64(blobId.blobId) + ".blob"
		const serviceUrl = new URL(getRestPath(StorageService.BlobService), server.url)
		const url = addParamsToUrl(serviceUrl, {"_body": body})
		return this._fileApp.download(url.toString(), headers, filename)
	}

	async _getDownloadToken(readArchiveId: Id): Promise<BlobAccessInfo> {
		const tokenRequest = createBlobAccessTokenData({
			readArchiveId
		})
		const {blobAccessInfo} = await serviceRequest(StorageService.BlobAccessTokenService, HttpMethod.POST, tokenRequest, BlobAccessTokenReturnTypeRef)
		return blobAccessInfo
	}

	// ↑↑↑ Download ↑↑↑
	//////////////////////////////////////////////////
	// ↓↓↓ Upload ↓↓↓

	async uploadFileBlobData(dataFile: DataFile, sessionKey: Aes128Key): Promise<Id> {
		let encryptedData = encryptBytes(sessionKey, dataFile.data)
		let postData = createFileDataDataPost()
		postData.size = dataFile.data.byteLength.toString()
		postData.group = this._login.getGroupId(GroupType.Mail) // currently only used for attachments
		const fileBlobServicePostReturn = await serviceRequest(TutanotaService.FileBlobService, HttpMethod.POST, postData, FileBlobServicePostReturnTypeRef, null, sessionKey)
		const fileData = await locator.cachingEntityClient.load(FileDataTypeRef, fileBlobServicePostReturn.fileData)

		// TODO: Watch for timeout of the access token when uploading many chunks
		const {storageAccessToken, servers} = fileBlobServicePostReturn.accessInfo
		const headers = Object.assign({
			storageAccessToken,
			'v': BlobDataGetTypeModel.version
		}, this._login.createAuthHeaders())

		const chunks = splitUint8ArrayInChunks(MAX_BLOB_SIZE_BYTES, encryptedData)
		for (let chunk of chunks) {
			const blobId = uint8ArrayToBase64(sha256Hash(chunk).slice(0, 6))
			const blobReferenceToken = await this._restClient.request(STORAGE_REST_PATH, HttpMethod.PUT, {blobId}, headers, chunk,
				MediaType.Binary, null, servers[0].url)

			const blobReferenceDataPut = createBlobReferenceDataPut({
				blobReferenceToken,
				type: createTypeInfo({application: FileDataTypeModel.app, typeId: String(FileDataTypeModel.id)}),
				instanceElementId: fileData._id
			})
			await serviceRequestVoid(StorageService.BlobReferenceService, HttpMethod.PUT, blobReferenceDataPut)
		}
		return fileData._id
	}

	/**
	 * Does not cleanup uploaded files. This is a responsibility of the caller
	 */
	async uploadFileDataNative(fileReference: FileReference, sessionKey: Aes128Key): Promise<Id> {
		if (this._suspensionHandler.isSuspended()) {
			return this._suspensionHandler.deferRequest(() => this.uploadFileDataNative(fileReference, sessionKey))
		}
		const encryptedFileInfo = await this._aesApp.aesEncryptFile(sessionKey, fileReference.location, random.generateRandomData(16))
		const fileData = createFileDataDataPost({
			size: encryptedFileInfo.unencSize.toString(),
			group: this._login.getGroupId(GroupType.Mail), // currently only used for attachments
		})

		const fileDataPostReturn = await serviceRequest(TutanotaService.FileDataService, HttpMethod.POST, fileData, FileDataReturnPostTypeRef, null, sessionKey)
		const fileDataId = fileDataPostReturn.fileData

		const headers = this._login.createAuthHeaders()
		headers['v'] = FileDataDataReturnTypeModel.version

		const url = addParamsToUrl(new URL(REST_PATH, getHttpOrigin()), {fileDataId})
		const {
			statusCode,
			errorId,
			precondition,
			suspensionTime
		} = await this._fileApp.upload(encryptedFileInfo.uri, url.toString(), headers)

		if (statusCode === 200) {
			return fileDataId;
		} else if (isSuspensionResponse(statusCode, suspensionTime)) {
			this._suspensionHandler.activateSuspensionIfInactive(Number(suspensionTime))
			return this._suspensionHandler.deferRequest(() => this.uploadFileDataNative(fileReference, sessionKey))
		} else {
			throw handleRestError(statusCode, ` | PUT ${url.toString()} failed to natively upload attachment`, errorId, precondition)
		}
	}

	/**
	 * @returns blobReferenceToken
	 */
	async uploadBlob(instance: {_type: TypeRef<any>}, blobData: Uint8Array, ownerGroupId: Id): Promise<Uint8Array> {
		const typeModel = await resolveTypeReference(instance._type)
		const {storageAccessToken, servers} = await this._getUploadToken(typeModel, ownerGroupId)

		const sessionKey = neverNull(await resolveSessionKey(typeModel, instance))
		const encryptedData = encryptBytes(sessionKey, blobData)
		const blobId = uint8ArrayToBase64(sha256Hash(encryptedData).slice(0, 6))

		const headers = Object.assign({
			storageAccessToken,
			'v': BlobDataGetTypeModel.version
		}, this._login.createAuthHeaders())
		return this._restClient.request(STORAGE_REST_PATH, HttpMethod.PUT, {blobId}, headers, encryptedData,
			MediaType.Binary, null, servers[0].url)
	}


	async _getUploadToken(typeModel: TypeModel, ownerGroupId: Id): Promise<BlobAccessInfo> {
		const tokenRequest = createBlobAccessTokenData({
			write: createBlobWriteData({
				type: createTypeInfo({
					application: typeModel.app,
					typeId: String(typeModel.id)
				}),
				archiveOwnerGroup: ownerGroupId,
			})
		})
		const {blobAccessInfo} = await serviceRequest(StorageService.BlobAccessTokenService, HttpMethod.POST, tokenRequest, BlobAccessTokenReturnTypeRef)
		return blobAccessInfo
	}


}
