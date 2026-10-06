export abstract class DomainException extends Error {
  constructor(
    public readonly errorCode: string,
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class EmailAlreadyExistsException extends DomainException {
  constructor() {
    super('EMAIL_ALREADY_EXISTS', 409, 'Email is already registered');
  }
}

export class InvalidCredentialsException extends DomainException {
  constructor() {
    super('INVALID_CREDENTIALS', 401, 'Invalid email or password');
  }
}

export class EmailNotConfirmedException extends DomainException {
  constructor() {
    super('EMAIL_NOT_CONFIRMED', 403, 'Email address has not been confirmed');
  }
}

export class InvalidTokenException extends DomainException {
  constructor() {
    super('INVALID_TOKEN', 401, 'Token is invalid');
  }
}

export class TokenExpiredException extends DomainException {
  constructor() {
    super('TOKEN_EXPIRED', 401, 'Token has expired');
  }
}

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class VideoTooLargeException extends DomainException {
  constructor() {
    super('VIDEO_TOO_LARGE', 413, 'Video exceeds the 10 GiB limit');
  }
}

export class InvalidVideoStatusException extends DomainException {
  constructor() {
    super(
      'INVALID_VIDEO_STATUS',
      409,
      'Operation not allowed for the current video status',
    );
  }
}

export class InvalidPartNumberException extends DomainException {
  constructor() {
    super('INVALID_PART_NUMBER', 400, 'Part number is out of range');
  }
}

export class InvalidUploadPartsException extends DomainException {
  constructor() {
    super(
      'INVALID_UPLOAD_PARTS',
      400,
      'Uploaded parts do not match the storage state',
    );
  }
}

export class UploadExpiredException extends DomainException {
  constructor() {
    super('UPLOAD_EXPIRED', 410, 'Upload session has expired');
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super('VIDEO_NOT_READY', 409, 'Video is not ready');
  }
}

export class TokenReuseDetectedException extends DomainException {
  constructor() {
    super(
      'TOKEN_REUSE_DETECTED',
      401,
      'Token reuse detected — all sessions revoked',
    );
  }
}
